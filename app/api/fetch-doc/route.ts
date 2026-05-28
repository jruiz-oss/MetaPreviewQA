import { NextResponse } from "next/server";
import { google } from "googleapis";
import { getOAuthClient } from "@/lib/google-auth";
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

async function readGoogleDoc(docId: string): Promise<string> {
  const auth = getOAuthClient();
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

// Caps to keep the QA request within Anthropic API limits (5MB/image, 100 images)
// and token cost reasonable.
const MAX_DRIVE_IMAGES = 16;
const MAX_IMAGE_BYTES = 4_500_000; // ~4.5MB before base64 expansion

export type DriveImage = { name: string; mediaType: string; data: string };

async function readDriveFolder(
  folderId: string,
  depth = 0,
  folderName?: string,
  images?: DriveImage[]
): Promise<string> {
  const auth = getOAuthClient();
  const drive = google.drive({ version: "v3", auth });
  const docs = google.docs({ version: "v1", auth });

  // Safety: don't recurse more than 3 levels deep
  if (depth > 3) {
    return "(Maximum folder depth reached — open this folder manually to review deeper contents.)";
  }

  // List ALL non-trashed items (files AND sub-folders)
  const listRes = await drive.files.list({
    q: `'${folderId}' in parents and trashed = false`,
    fields: "files(id, name, mimeType)",
    pageSize: 50,
    supportsAllDrives: true,
    includeItemsFromAllDrives: true,
    corpora: "allDrives",
  });

  console.log(`[fetch-doc] folder ${folderId} (depth ${depth}) → ${listRes.data.files?.length ?? 0} items found:`, JSON.stringify(listRes.data.files?.map(f => ({ name: f.name, mimeType: f.mimeType })) ?? []));

  const allItems = listRes.data.files ?? [];
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

      // Download viewable images so the QA model can actually inspect them.
      // PSDs, PDFs, video and audio are skipped (not viewable) — filename only.
      if (images && VIEWABLE_IMAGE_MIME.has(file.mimeType)) {
        if (images.length >= MAX_DRIVE_IMAGES) {
          console.log(`[fetch-doc] SKIP image "${file.name}" — image cap reached (${MAX_DRIVE_IMAGES}); not cross-referenced.`);
        } else {
          try {
            const imgRes = await drive.files.get(
              { fileId: file.id, alt: "media", supportsAllDrives: true },
              { responseType: "arraybuffer" }
            );
            const buf = Buffer.from(imgRes.data as ArrayBuffer);
            if (buf.length <= MAX_IMAGE_BYTES) {
              images.push({
                name: file.name ?? "creative",
                mediaType: file.mimeType,
                data: buf.toString("base64"),
              });
              console.log(`[fetch-doc] DOWNLOADED image "${file.name}" (${file.mimeType}, ${(buf.length / 1024).toFixed(0)} KB) → cross-referenced [${images.length}/${MAX_DRIVE_IMAGES}].`);
            } else {
              console.log(`[fetch-doc] SKIP image "${file.name}" — ${(buf.length / 1_000_000).toFixed(1)} MB exceeds ${(MAX_IMAGE_BYTES / 1_000_000).toFixed(1)} MB limit; not cross-referenced.`);
            }
          } catch (err) {
            const msg = err instanceof Error ? err.message : "unknown error";
            console.log(`[fetch-doc] SKIP image "${file.name}" — download failed: ${msg}`);
          }
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
    try {
      const subContent = await readDriveFolder(folder.id, depth + 1, folder.name, images);
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

  try {
    // 1. Direct Google Doc link
    const docId = extractDocId(url);
    if (docId) {
      const content = await readGoogleDoc(docId);
      if (!content) {
        return NextResponse.json({ error: "Doc appears to be empty." }, { status: 422 });
      }
      return NextResponse.json({ content: content.slice(0, 12000), type: "doc" });
    }

    // 2. Google Drive folder link
    const folderId = extractFolderId(url);
    if (folderId) {
      const images: DriveImage[] = [];
      const content = await readDriveFolder(folderId, 0, undefined, images);
      return NextResponse.json({ content: content.slice(0, 30000), type: "folder", images });
    }

    // 3. Google Drive file link (non-Doc)
    const fileId = extractFileId(url);
    if (fileId) {
      const auth = getOAuthClient();
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
