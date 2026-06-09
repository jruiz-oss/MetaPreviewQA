import { NextResponse } from "next/server";
import { google } from "googleapis";
import { getOAuthClient } from "@/lib/google-auth";
import { getStoredRefreshToken } from "@/lib/token-store";
import mammoth from "mammoth";

// ─── URL parsers ──────────────────────────────────────────────────────────────

function extractDocId(url: string): string | null {
  const match = url.match(/\/document\/d\/([a-zA-Z0-9_-]+)/);
  return match ? match[1] : null;
}

function extractFolderId(url: string): string | null {
  // Matches /folders/<id> in drive.google.com URLs
  const match = url.match(/\/folders\/([a-zA-Z0-9_-]+)/);
  return match ? match[1] : null;
}

function extractFileId(url: string): string | null {
  // Matches /file/d/<id>/
  const match = url.match(/\/file\/d\/([a-zA-Z0-9_-]+)/);
  return match ? match[1] : null;
}

// ─── Readers ──────────────────────────────────────────────────────────────────

async function readGoogleDoc(docId: string, auth: ReturnType<typeof getOAuthClient>): Promise<string> {
  const docs = google.docs({ version: "v1", auth });
  const res = await docs.documents.get({ documentId: docId });
  const doc = res.data;

  // Walk the body content and extract plain text
  const text: string[] = [];
  for (const block of doc.body?.content ?? []) {
    if (block.paragraph) {
      for (const el of block.paragraph.elements ?? []) {
        if (el.textRun?.content) {
          text.push(el.textRun.content);
        }
      }
    } else if (block.table) {
      for (const row of block.table.tableRows ?? []) {
        for (const cell of row.tableCells ?? []) {
          for (const cellBlock of cell.content ?? []) {
            for (const el of cellBlock.paragraph?.elements ?? []) {
              if (el.textRun?.content) {
                text.push(el.textRun.content);
              }
            }
          }
        }
      }
    }
  }
  return text.join("").trim();
}

const WORD_MIME_TYPES = new Set([
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document", // .docx
  "application/msword", // .doc
  "application/vnd.ms-word",
]);

const PDF_MIME = "application/pdf";

// Image types the model can actually view (PSD, PDF, etc. are excluded — not viewable).
const VIEWABLE_IMAGE_MIME = new Set([
  "image/jpeg",
  "image/png",
  "image/webp",
  "image/gif",
]);

// Cap how many images we hand off for cross-referencing. We pass lightweight
// references (Drive file id) — NOT the bytes — so the browser payload stays
// tiny and well under Vercel's ~4.5MB serverless request-body limit. The QA
// route downloads the actual bytes server-side.
const MAX_DRIVE_IMAGES = 16;

export type DriveImageRef = { id: string; name: string; mediaType: string };

// No fixed depth cap — recursion follows the tree as deep as it goes, but is
// bounded by a total-folders budget and a cycle guard (Drive shortcuts can
// loop), and stops early once the image cap is filled inside approval branches.
const MAX_FOLDERS_SCANNED = 100;
type ScanState = { foldersVisited: number; visitedIds: Set<string> };

async function readDriveFolder(
  folderId: string,
  auth: ReturnType<typeof getOAuthClient>,
  depth = 0,
  folderName?: string,
  images?: DriveImageRef[],
  pathPrefix = "",
  insideApprovalFolder = false,  // true once we've entered an "approval"-named folder
  scan: ScanState = { foldersVisited: 0, visitedIds: new Set() }
): Promise<string> {
  const drive = google.drive({ version: "v3", auth });
  const docs = google.docs({ version: "v1", auth });

  // Cycle guard: skip folders we've already scanned (shortcut loops).
  if (scan.visitedIds.has(folderId)) {
    return "(Folder already scanned — skipping repeat visit.)";
  }
  scan.visitedIds.add(folderId);

  // Total scan budget replaces the old depth-3 cap.
  if (scan.foldersVisited >= MAX_FOLDERS_SCANNED) {
    return `(Scan budget of ${MAX_FOLDERS_SCANNED} folders reached — open this folder manually to review contents.)`;
  }
  scan.foldersVisited++;

  // For the root call (depth=0), we don't know the folder's own name yet. Fetch
  // it so we can detect when the user linked directly to "For Approval" itself —
  // in that case insideApprovalFolder would otherwise start false and images
  // inside subfolders like "Frys GC Giveaway/V1/" would be silently skipped.
  let selfName = folderName;
  if (!selfName && depth === 0) {
    try {
      const metaRes = await drive.files.get({
        fileId: folderId,
        fields: "name",
        supportsAllDrives: true,
      });
      selfName = metaRes.data.name ?? undefined;
      if (selfName) console.log(`[fetch-doc] Root folder name resolved: "${selfName}"`);
    } catch {
      // Proceed without the name — approval detection falls back to subfolder names
    }
  }
  // Propagate the "inside approval" flag: true if inherited from a parent folder,
  // OR if the current folder itself has "approval" in its name (e.g. the user
  // pasted a link directly to "For Approval" or "For Client Approval").
  const selfIsApproval = (selfName ?? "").toLowerCase().includes("approval");
  const effectiveInsideApproval = insideApprovalFolder || selfIsApproval;
  if (selfIsApproval && !insideApprovalFolder) {
    console.log(`[fetch-doc] Folder "${selfName}" is itself an approval folder — images inside will be queued.`);
  }

  // List ALL non-trashed items (files AND sub-folders), following pagination.
  // Previously a single pageSize:50 call silently dropped item 51+ — a folder
  // with many exports could lose the copy doc or approved creative with no
  // visible error. A page cap bounds runaway folders.
  const MAX_LIST_PAGES = 10; // 10 × 100 = up to 1000 items per folder
  type DriveFile = { id?: string | null; name?: string | null; mimeType?: string | null };
  const allItems: DriveFile[] = [];
  let pageToken: string | undefined = undefined;
  for (let page = 0; page < MAX_LIST_PAGES; page++) {
    // Explicit annotation: pageToken feeds the call args and is assigned from
    // the response, which otherwise makes TS flag a circular type inference.
    const listRes: { data: { nextPageToken?: string | null; files?: DriveFile[] } } = await drive.files.list({
      q: `'${folderId}' in parents and trashed = false`,
      fields: "nextPageToken, files(id, name, mimeType)",
      pageSize: 100,
      pageToken,
      supportsAllDrives: true,
      includeItemsFromAllDrives: true,
      corpora: "allDrives",
    });
    allItems.push(...(listRes.data.files ?? []));
    pageToken = listRes.data.nextPageToken ?? undefined;
    if (!pageToken) break;
  }
  if (pageToken) {
    console.log(`[fetch-doc] folder ${folderId} — page cap reached (${MAX_LIST_PAGES} pages); remaining items not listed.`);
  }

  console.log(`[fetch-doc] folder ${folderId} (depth ${depth}) → ${allItems.length} items found:`, JSON.stringify(allItems.map(f => ({ name: f.name, mimeType: f.mimeType }))));
  if (allItems.length === 0) {
    return "(No files found in this folder — the folder may be empty, or the authenticated account may not have access to its contents.)";
  }

  const subFolders = allItems.filter(f => f.mimeType === "application/vnd.google-apps.folder");
  const files = allItems.filter(f => f.mimeType !== "application/vnd.google-apps.folder");

  const sections: string[] = [];

  // ── Process files in this folder ──────────────────────────────────────────
  for (const file of files) {
    if (!file.id || !file.mimeType) continue;

    // Image/video/audio — list filename so QA knows what creative assets exist
    if (
      file.mimeType.startsWith("image/") ||
      file.mimeType.startsWith("video/") ||
      file.mimeType.startsWith("audio/")
    ) {
      sections.push(`[Creative asset: ${file.name}]`);

      // Queue viewable images (by reference, not bytes) for server-side download
      // in the QA route. PSDs, PDFs, video and audio are skipped (not viewable).
      // Images are ONLY collected from "For Approval" folders (or subfolders within
      // them) — the "Creative" folder holds PSDs/concepts and must be ignored.
      if (images && VIEWABLE_IMAGE_MIME.has(file.mimeType)) {
        if (!effectiveInsideApproval) {
          console.log(`[fetch-doc] SKIP image "${file.name}" — not inside an approval folder; only images in "For Approval" (or similar) folders are cross-referenced.`);
        } else if (images.length >= MAX_DRIVE_IMAGES) {
          console.log(`[fetch-doc] SKIP image "${file.name}" — image cap reached (${MAX_DRIVE_IMAGES}); not cross-referenced.`);
        } else if (file.id) {
          // Prefix with the relative folder path so the QA matcher can tell which
          // subfolder (e.g. "V1/" vs "V2/") an image came from — that's what
          // distinguishes versions, and it lives in the folder, not the filename.
          const qualifiedName = `${pathPrefix}${file.name ?? "creative"}`;
          images.push({ id: file.id, name: qualifiedName, mediaType: file.mimeType });
          console.log(`[fetch-doc] QUEUED image "${qualifiedName}" (${file.mimeType}) for cross-reference [${images.length}/${MAX_DRIVE_IMAGES}].`);
        }
      } else if (images) {
        console.log(`[fetch-doc] SKIP asset "${file.name}" — type ${file.mimeType} not viewable; filename only, not cross-referenced.`);
      }
      continue;
    }

    try {
      let content = "";

      if (file.mimeType === "application/vnd.google-apps.document") {
        // Native Google Doc
        const docRes = await docs.documents.get({ documentId: file.id });
        const text: string[] = [];
        for (const block of docRes.data.body?.content ?? []) {
          if (block.paragraph) {
            for (const el of block.paragraph.elements ?? []) {
              if (el.textRun?.content) text.push(el.textRun.content);
            }
          } else if (block.table) {
            for (const row of block.table.tableRows ?? []) {
              for (const cell of row.tableCells ?? []) {
                for (const cellBlock of cell.content ?? []) {
                  for (const el of cellBlock.paragraph?.elements ?? []) {
                    if (el.textRun?.content) text.push(el.textRun.content);
                  }
                }
              }
            }
          }
        }
        content = text.join("").trim();

      } else if (WORD_MIME_TYPES.has(file.mimeType)) {
        // Word document — download binary and extract text with mammoth
        const downloadRes = await drive.files.get(
          { fileId: file.id, alt: "media", supportsAllDrives: true },
          { responseType: "arraybuffer" }
        );
        const buffer = Buffer.from(downloadRes.data as ArrayBuffer);
        const result = await mammoth.extractRawText({ buffer });
        content = result.value.trim();

      } else if (file.mimeType === "application/vnd.google-apps.spreadsheet") {
        // Google Sheet — export as CSV
        const exportRes = await drive.files.export(
          { fileId: file.id, mimeType: "text/csv" },
          { responseType: "text" }
        );
        content = String(exportRes.data).trim();

      } else if (file.mimeType === PDF_MIME) {
        // PDFs: try Drive's plain-text export (works if Drive has indexed the PDF)
        try {
          const exportRes = await drive.files.export(
            { fileId: file.id, mimeType: "text/plain" },
            { responseType: "text" }
          );
          content = String(exportRes.data).trim();
        } catch {
          content = "(PDF — could not extract text automatically. Open the file directly to review.)";
        }

      } else if (file.mimeType === "text/plain") {
        const downloadRes = await drive.files.get(
          { fileId: file.id, alt: "media", supportsAllDrives: true },
          { responseType: "text" }
        );
        content = String(downloadRes.data).trim();

      } else {
        // Unknown type — at minimum record the filename
        content = `(File type ${file.mimeType} is not directly readable — open this file manually to review.)`;
      }

      if (content) {
        sections.push(`[File: ${file.name}]\n${content}`);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Unknown error";
      sections.push(`[File: ${file.name}]\n(Could not read this file: ${msg})`);
    }
  }

  // ── Recurse into sub-folders ───────────────────────────────────────────────
  for (const folder of subFolders) {
    if (!folder.id || !folder.name) continue;
    const nameLC = folder.name.toLowerCase();
    // "Creative" folders hold PSDs/concepts — never pull images from them.
    // "For Approval" (or "Approval") folders hold the signed-off exports — always pull images.
    // Once inside an approval folder, all deeper subfolders inherit that flag.
    const isApprovalFolder = nameLC.includes("approval");
    const isCreativeFolder = nameLC === "creative" || nameLC.startsWith("creative ");
    const passImages = isCreativeFolder ? undefined : images; // block images from creative folder
    const nextInsideApproval = effectiveInsideApproval || isApprovalFolder;
    // Early stop: once the image cap is full, deeper approval-branch folders can
    // only contribute more images — nothing left to find there, so skip them.
    if (images && images.length >= MAX_DRIVE_IMAGES && nextInsideApproval) {
      console.log(`[fetch-doc] SKIP subfolder "${folder.name}" — image cap (${MAX_DRIVE_IMAGES}) already reached; nothing more needed from approval branches.`);
      sections.push(`[Sub-folder: ${folder.name}]\n(Skipped — image cap of ${MAX_DRIVE_IMAGES} already reached.)`);
      continue;
    }
    if (isCreativeFolder) {
      console.log(`[fetch-doc] Entering "Creative" subfolder "${folder.name}" — images will NOT be queued from here.`);
    } else if (isApprovalFolder) {
      console.log(`[fetch-doc] Entering approval subfolder "${folder.name}" — images WILL be queued from here.`);
    }
    try {
      const subContent = await readDriveFolder(folder.id, auth, depth + 1, folder.name, passImages, `${pathPrefix}${folder.name}/`, nextInsideApproval, scan);
      sections.push(`[Sub-folder: ${folder.name}]\n${subContent}`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Unknown error";
      sections.push(`[Sub-folder: ${folder.name}]\n(Could not read this folder: ${msg})`);
    }
  }

  const header = folderName ? `=== Folder: ${folderName} ===\n` : "";
  return sections.length > 0
    ? header + sections.join("\n\n---\n\n")
    : header + "(No readable content found in this folder.)";
}

// ─── Route handler ────────────────────────────────────────────────────────────

export async function POST(request: Request) {
  const { url } = await request.json();

  if (!url) {
    return NextResponse.json({ error: "No URL provided" }, { status: 400 });
  }

  // Resolve auth: KV-stored token (set after browser OAuth) wins over env var
  const storedToken = await getStoredRefreshToken();
  const auth = getOAuthClient(storedToken);

  try {
    // 1. Direct Google Doc link
    const docId = extractDocId(url);
    if (docId) {
      const content = await readGoogleDoc(docId, auth);
      if (!content) {
        return NextResponse.json({ error: "Doc appears to be empty." }, { status: 422 });
      }
      return NextResponse.json({ content: content.slice(0, 12000), type: "doc" });
    }

    // 2. Google Drive folder link
    const folderId = extractFolderId(url);
    if (folderId) {
      const images: DriveImageRef[] = [];
      const content = await readDriveFolder(folderId, auth, 0, undefined, images);
      return NextResponse.json({ content: content.slice(0, 30000), type: "folder", images });
    }

    // 3. Google Drive file link (non-Doc)
    const fileId = extractFileId(url);
    if (fileId) {
      const drive = google.drive({ version: "v3", auth });
      // Try exporting as plain text
      const exportRes = await drive.files.export(
        { fileId, mimeType: "text/plain" },
        { responseType: "text" }
      );
      const content = String(exportRes.data).trim();
      if (!content) {
        return NextResponse.json({ error: "File appears to be empty." }, { status: 422 });
      }
      return NextResponse.json({ content: content.slice(0, 12000), type: "file" });
    }

    return NextResponse.json(
      { error: "URL is not a recognized Google Doc or Drive link." },
      { status: 400 }
    );
  } catch (err: unknown) {
    console.error("fetch-doc error:", err);
    const message =
      err instanceof Error ? err.message : "Failed to read document";
    const isAuth = message.includes("credentials") || message.includes("Missing Google");
    return NextResponse.json(
      { error: isAuth ? message : `Could not read this link: ${message}` },
      { status: isAuth ? 500 : 502 }
    );
  }
}
