import { NextResponse } from "next/server";
import { google, docs_v1 } from "googleapis";
import { getGoogleAuth } from "@/lib/google-auth";
import { classifyFetchError } from "@/lib/error-classify";
import { isAuthedRequest } from "@/lib/auth";
import {
  isOldFolderName,
  isChannelFolderName,
  isApprovalFolderName,
  pickSocialFolders,
  resolveShortcut,
  type DriveItemLite,
} from "@/lib/drive-folders";
import mammoth from "mammoth";

// Diagnostic logging is gated behind QA_DEBUG so production logs stay quiet.
// Set QA_DEBUG=1 to re-enable verbose folder/asset tracing.
const dbg: (...args: unknown[]) => void =
  process.env.QA_DEBUG === "1" ? console.log.bind(console) : () => {};

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

// A text run is treated as "deleted" when it's struck through. In our copy /
// work-order docs, strikethrough marks wording that was removed in revision and
// the replacement is typically highlighted right after it (e.g. CTA "See You
// ~~at the Bar~~ There"). If we keep the struck text, QA ends up comparing the
// live ad against BOTH the old and the new wording, so a legitimately changed
// CTA / offer can read as a false match (or get flagged against the wrong
// version). Dropping struck runs leaves only the surviving, current copy.
//
// Scope note (intentionally conservative): we ONLY drop manual strikethrough.
// We do NOT inject any marker for highlighted ("new") text — the copy check
// matches the live ad against this text more or less verbatim, and an inline
// tag like "[new]" would corrupt that match. Once the struck text is gone, the
// highlighted text is simply what remains, which is exactly what we want.
// Suggesting-mode tracked changes (suggestedDeletionIds) are a different data
// path and are NOT handled here.
function runIsDeleted(el: docs_v1.Schema$ParagraphElement): boolean {
  return el.textRun?.textStyle?.strikethrough === true;
}

// Walk a Google Docs body and extract plain text, skipping struck-through runs.
function extractDocText(content: docs_v1.Schema$StructuralElement[] | undefined): string {
  const out: string[] = [];
  const pushParagraph = (para: docs_v1.Schema$Paragraph | null | undefined) => {
    // FIX #5: collect the paragraph's surviving runs, then guarantee a trailing
    // newline. Google Docs usually ends a paragraph's last run with "\n", but
    // table cells (and some structural elements) do NOT, so adjacent cells used
    // to glue together ("Price" + "Free" → "PriceFree") and produce phantom
    // copy-mismatch findings. Terminating every non-empty paragraph keeps cell
    // and paragraph boundaries intact. Trailing whitespace is harmless — the QA
    // prompt treats whitespace/line-break differences as non-findings.
    let text = "";
    for (const el of para?.elements ?? []) {
      if (el.textRun?.content && !runIsDeleted(el)) {
        text += el.textRun.content;
      }
    }
    if (text.length === 0) return;
    out.push(text.endsWith("\n") ? text : `${text}\n`);
  };
  for (const block of content ?? []) {
    if (block.paragraph) {
      pushParagraph(block.paragraph);
    } else if (block.table) {
      for (const row of block.table.tableRows ?? []) {
        for (const cell of row.tableCells ?? []) {
          for (const cellBlock of cell.content ?? []) {
            pushParagraph(cellBlock.paragraph);
          }
        }
      }
    }
  }
  return out.join("").trim();
}

async function readGoogleDoc(docId: string, auth: Awaited<ReturnType<typeof getGoogleAuth>>): Promise<string> {
  const docs = google.docs({ version: "v1", auth });
  const res = await docs.documents.get({ documentId: docId });
  return extractDocText(res.data.body?.content);
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

// Video types Drive auto-generates a thumbnail frame for — the QA route fetches
// that thumbnail (no ffmpeg on Vercel, so the raw video can't be decoded).
const VIEWABLE_VIDEO_MIME = new Set([
  "video/mp4",
  "video/quicktime",
  "video/x-msvideo",
  "video/webm",
  "video/x-matroska",
]);

// Cap how many images we hand off for cross-referencing. We pass lightweight
// references (Drive file id) — NOT the bytes — so the browser payload stays
// tiny and well under Vercel's ~4.5MB serverless request-body limit. The QA
// route downloads the actual bytes server-side.
// Refs cost ~100 bytes each and the QA route ranks + picks a handful per ad
// unit before downloading any bytes, so a bigger pool here only improves
// matching (a too-small pool is how approved assets get skipped). 64 was being
// hit by multi-concept campaigns (each concept has several sizes × variants ×
// "Copy of" duplicates), truncating later concepts before they could be matched
// — which surfaced as "creative missing". 192 comfortably covers a full
// multi-concept month while staying tiny on the wire.
const MAX_DRIVE_IMAGES = 192;

export type DriveImageRef = { id: string; name: string; mediaType: string };

// No fixed depth cap — recursion follows the tree as deep as it goes, but is
// bounded by a total-folders budget and a cycle guard (Drive shortcuts can
// loop), and stops early once the image cap is filled inside approval branches.
const MAX_FOLDERS_SCANNED = 100;
type ScanState = { foldersVisited: number; visitedIds: Set<string> };

async function readDriveFolder(
  folderId: string,
  auth: Awaited<ReturnType<typeof getGoogleAuth>>,
  depth = 0,
  folderName?: string,
  images?: DriveImageRef[],
  pathPrefix = "",
  insideApprovalFolder = false,  // true once we've entered an "approval"-named folder
  scan: ScanState = { foldersVisited: 0, visitedIds: new Set() },
  // FIX #3: when true, the approval-folder gate is bypassed — every non-Creative,
  // non-OLD folder's images are queued. The route only sets this on a SECOND pass,
  // after the strict (approval-gated) pass queued zero images, so real creative in
  // a folder that simply isn't named "approval" (e.g. "Final Exports/" sitting
  // beside an empty "For Approval/") is no longer silently skipped.
  forceApprove = false
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
      if (selfName) dbg(`[fetch-doc] Root folder name resolved: "${selfName}"`);
    } catch {
      // Proceed without the name — approval detection falls back to subfolder names
    }
  }
  // Propagate the "inside approval" flag: true if inherited from a parent folder,
  // OR if the current folder itself has "approval" in its name (e.g. the user
  // pasted a link directly to "For Approval" or "For Client Approval").
  // A third case is handled below after listing items: if the WO link points
  // directly into the approved assets (e.g. "Carousel/" or "Static/"), there
  // is no "approval"-named ancestor — auto-approve at that point.
  // FIX #22: recognition broadened to "approved"/"sign-off" spellings (see
  // lib/drive-folders.ts) — an "Approved/" root pasted directly now gates on.
  const selfIsApproval = isApprovalFolderName(selfName ?? "");
  let effectiveInsideApproval = insideApprovalFolder || selfIsApproval || forceApprove;
  if (selfIsApproval && !insideApprovalFolder) {
    dbg(`[fetch-doc] Folder "${selfName}" is itself an approval folder — images inside will be queued.`);
  }

  // List ALL non-trashed items (files AND sub-folders), following pagination.
  // Previously a single pageSize:50 call silently dropped item 51+ — a folder
  // with many exports could lose the copy doc or approved creative with no
  // visible error. A page cap bounds runaway folders.
  const MAX_LIST_PAGES = 10; // 10 × 100 = up to 1000 items per folder
  type DriveFile = DriveItemLite;
  const allItems: DriveFile[] = [];
  let pageToken: string | undefined = undefined;
  for (let page = 0; page < MAX_LIST_PAGES; page++) {
    // Explicit annotation: pageToken feeds the call args and is assigned from
    // the response, which otherwise makes TS flag a circular type inference.
    const listRes: { data: { nextPageToken?: string | null; files?: DriveFile[] } } = await drive.files.list({
      q: `'${folderId}' in parents and trashed = false`,
      // shortcutDetails: FIX #20 — resolve shortcuts to their targets instead
      // of treating them as unreadable files (creative behind a folder/image
      // shortcut was silently never scanned).
      fields: "nextPageToken, files(id, name, mimeType, shortcutDetails)",
      pageSize: 100,
      pageToken,
      supportsAllDrives: true,
      includeItemsFromAllDrives: true,
      corpora: "allDrives",
    });
    // Map shortcuts onto their target id/mimeType up front: a folder shortcut
    // then recurses like a real folder (the visitedIds cycle guard makes loops
    // safe) and an image/video shortcut queues its TARGET id so the download
    // fetches real bytes. Unresolvable shortcuts pass through unchanged.
    allItems.push(...(listRes.data.files ?? []).map(resolveShortcut));
    pageToken = listRes.data.nextPageToken ?? undefined;
    if (!pageToken) break;
  }
  if (pageToken) {
    dbg(`[fetch-doc] folder ${folderId} — page cap reached (${MAX_LIST_PAGES} pages); remaining items not listed.`);
  }

  dbg(`[fetch-doc] folder ${folderId} (depth ${depth}) → ${allItems.length} items found:`, JSON.stringify(allItems.map(f => ({ name: f.name, mimeType: f.mimeType }))));
  if (allItems.length === 0) {
    return "(No files found in this folder — the folder may be empty, or the authenticated account may not have access to its contents.)";
  }

  const subFolders = allItems.filter(f => f.mimeType === "application/vnd.google-apps.folder");
  const files = allItems.filter(f => f.mimeType !== "application/vnd.google-apps.folder");

  // Auto-approve: if the WO link lands directly inside the approved assets
  // (e.g. straight to "Carousel/" or "Static/v1/") there is no "approval"-
  // named folder in the path, so effectiveInsideApproval would stay false and
  // every image would be silently skipped. Fix: at the root call, if none of
  // the direct subfolders carry "approval" in their name, treat this folder as
  // already inside the approval context.
  if (!effectiveInsideApproval && depth === 0) {
    const hasApprovalSubfolder = subFolders.some(f => isApprovalFolderName(f.name ?? ""));
    if (!hasApprovalSubfolder) {
      effectiveInsideApproval = true;
      dbg(`[fetch-doc] Folder "${selfName ?? folderId}" has no approval subfolder — treating as already inside approval context.`);
    }
  }

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

      // Queue viewable images and videos (by reference, not bytes) for server-side
      // download in the QA route. Images are sent directly; videos are represented
      // by their Drive-generated thumbnail frame. PSDs, PDFs, and audio are skipped.
      // Assets are ONLY collected from "For Approval" folders (or subfolders within
      // them) — the "Creative" folder holds PSDs/concepts and must be ignored.
      if (images && (VIEWABLE_IMAGE_MIME.has(file.mimeType) || VIEWABLE_VIDEO_MIME.has(file.mimeType))) {
        if (!effectiveInsideApproval) {
          dbg(`[fetch-doc] SKIP asset "${file.name}" — not inside an approval folder; only assets in "For Approval" (or similar) folders are cross-referenced.`);
        } else if (images.length >= MAX_DRIVE_IMAGES) {
          dbg(`[fetch-doc] SKIP asset "${file.name}" — asset cap reached (${MAX_DRIVE_IMAGES}); not cross-referenced.`);
        } else if (file.id) {
          // Prefix with the relative folder path so the QA matcher can tell which
          // subfolder (e.g. "V1/" vs "V2/") an image came from — that's what
          // distinguishes versions, and it lives in the folder, not the filename.
          const qualifiedName = `${pathPrefix}${file.name ?? "creative"}`;
          images.push({ id: file.id, name: qualifiedName, mediaType: file.mimeType });
          dbg(`[fetch-doc] QUEUED image "${qualifiedName}" (${file.mimeType}) for cross-reference [${images.length}/${MAX_DRIVE_IMAGES}].`);
        }
      } else if (images) {
        dbg(`[fetch-doc] SKIP asset "${file.name}" — type ${file.mimeType} not viewable or not video; filename only, not cross-referenced.`);
      }
      continue;
    }

    try {
      let content = "";

      if (file.mimeType === "application/vnd.google-apps.document") {
        // Native Google Doc — same strikethrough-aware extraction as readGoogleDoc
        const docRes = await docs.documents.get({ documentId: file.id });
        content = extractDocText(docRes.data.body?.content);

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

  // ── Tier 1: Channel-folder detection ──────────────────────────────────────
  // Vera is Social/Meta-only. If this folder level contains channel subfolders
  // (Social, Display, Native, etc.), navigate straight into Social and skip the
  // rest. This handles the "For Approval → Display / Native / Social / xxOLD"
  // structure without needing any manual selection.
  //
  // Detection: if ANY subfolder name matches a known channel keyword, we treat
  // this as a channel-level folder. Priority: Social wins every time.
  //
  // Tier 2 (creative-type / version / size folders with no channel names) falls
  // through naturally — all subfolders are processed and the QA route's TF-IDF
  // ranking picks the right assets per ad unit based on folder path prefixes.
  // Channel + OLD + approval name rules live in lib/drive-folders.ts (FIX
  // #19/#21/#22 — extracted for unit-testability, original rules preserved).
  // FIX #21 broadened the channel lexicon ("Meta", "Facebook", "Paid Search",
  // "Email", …) and enters ALL social-matching folders — the old `.find`
  // picked only the first, so a "Social Video/" sibling of "Social/" was
  // silently skipped.
  const hasChannelFolders = subFolders.some(f => isChannelFolderName(f.name ?? ""));
  let foldersToProcess = subFolders;

  if (hasChannelFolders) {
    const socialFolders = pickSocialFolders(subFolders);
    if (socialFolders.length > 0) {
      const skipped = subFolders.filter(f => !socialFolders.includes(f)).map(f => f.name).join(", ");
      dbg(`[fetch-doc] Channel folders detected — navigating into ${socialFolders.map(f => f.name).join(" + ")} only (skipping: ${skipped})`);
      foldersToProcess = socialFolders;
    } else {
      // Social folder not found by name — skip OLD folders, process the rest
      foldersToProcess = subFolders.filter(f => !isOldFolderName(f.name ?? ""));
      const skipped = subFolders.filter(f => isOldFolderName(f.name ?? "")).map(f => f.name).join(", ");
      if (skipped) dbg(`[fetch-doc] Channel folders detected but no "Social" folder — skipping OLD: ${skipped}`);
    }
  }

  // Skip deprecated/old dumps everywhere — not only in the channel branch above.
  // An "xxOLD" or "OLD" folder beside the current approved exports holds last
  // cycle's creative and must never be queued for matching.
  {
    const oldOnes = foldersToProcess.filter((f) => isOldFolderName(f.name ?? ""));
    if (oldOnes.length) {
      dbg(`[fetch-doc] Skipping OLD/archive folder(s): ${oldOnes.map((f) => f.name).join(", ")}`);
      foldersToProcess = foldersToProcess.filter((f) => !isOldFolderName(f.name ?? ""));
    }
  }

  // ── Recurse into sub-folders ───────────────────────────────────────────────
  for (const folder of foldersToProcess) {
    if (!folder.id || !folder.name) continue;
    const nameLC = folder.name.toLowerCase();
    // "Creative" folders hold PSDs/concepts — never pull images from them.
    // "For Approval" / "Approved" / "Sign-Off" folders hold the signed-off
    // exports — always pull images (FIX #22 broadened the recognized names).
    // Once inside an approval folder, all deeper subfolders inherit that flag.
    const isApprovalFolder = isApprovalFolderName(folder.name);
    const isCreativeFolder = nameLC === "creative" || nameLC.startsWith("creative ");
    const passImages = isCreativeFolder ? undefined : images; // block images from creative folder
    const nextInsideApproval = effectiveInsideApproval || isApprovalFolder;
    // Early stop: once the image cap is full, deeper approval-branch folders can
    // only contribute more images — nothing left to find there, so skip them.
    if (images && images.length >= MAX_DRIVE_IMAGES && nextInsideApproval) {
      dbg(`[fetch-doc] SKIP subfolder "${folder.name}" — image cap (${MAX_DRIVE_IMAGES}) already reached; nothing more needed from approval branches.`);
      sections.push(`[Sub-folder: ${folder.name}]\n(Skipped — image cap of ${MAX_DRIVE_IMAGES} already reached.)`);
      continue;
    }
    if (isCreativeFolder) {
      dbg(`[fetch-doc] Entering "Creative" subfolder "${folder.name}" — images will NOT be queued from here.`);
    } else if (isApprovalFolder) {
      dbg(`[fetch-doc] Entering approval subfolder "${folder.name}" — images WILL be queued from here.`);
    }
    try {
      const subContent = await readDriveFolder(folder.id, auth, depth + 1, folder.name, passImages, `${pathPrefix}${folder.name}/`, nextInsideApproval, scan, forceApprove);
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

// Truncate content to a cap, but SAY SO when it bites. A silent slice() used to
// cut long copy docs / folder listings with no signal, so the model could
// report copy or assets as "absent from the doc" when they simply lived past
// the cut — a false-mismatch source. The marker tells the model the truth:
// don't assert absence of anything that may be in the unreviewed remainder.
function truncateWithMarker(content: string, cap: number): string {
  if (content.length <= cap) return content;
  return (
    content.slice(0, cap) +
    `\n\n[NOTE: this document was TRUNCATED at ${cap.toLocaleString()} characters — ${(content.length - cap).toLocaleString()} characters were NOT included. Do NOT report copy, assets, or details as missing/absent from this document: they may exist in the truncated portion. Treat any "not found in doc" conclusion as couldn't-verify.]`
  );
}

// ─── Route handler ────────────────────────────────────────────────────────────

export async function POST(request: Request) {
  if (!isAuthedRequest(request)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const { url } = await request.json();

  if (!url) {
    return NextResponse.json({ error: "No URL provided" }, { status: 400 });
  }

  const auth = await getGoogleAuth();

  try {
    // 1. Direct Google Doc link
    const docId = extractDocId(url);
    if (docId) {
      const content = await readGoogleDoc(docId, auth);
      if (!content) {
        return NextResponse.json({ error: "Doc appears to be empty." }, { status: 422 });
      }
      return NextResponse.json({ content: truncateWithMarker(content, 12000), type: "doc" });
    }

    // 2. Google Drive folder link
    const folderId = extractFolderId(url);
    if (folderId) {
      const images: DriveImageRef[] = [];
      let content = await readDriveFolder(folderId, auth, 0, undefined, images);
      // FIX #3: the strict pass only queues images from "approval"-named folders.
      // If it found NONE, the creative may simply live in a folder that isn't
      // named "approval" (e.g. "Final Exports/" beside an empty "For Approval/").
      // Re-scan once with the approval gate bypassed so that creative is queued
      // rather than reported as "no creative in Drive". Creative/OLD folders are
      // still skipped on this pass. A fresh scan state avoids the cycle guard
      // short-circuiting the repeat visit.
      if (images.length === 0) {
        dbg(`[fetch-doc] Strict approval pass queued 0 images — retrying with approval gate bypassed.`);
        content = await readDriveFolder(folderId, auth, 0, undefined, images, "", false, { foldersVisited: 0, visitedIds: new Set() }, true);
      }
      return NextResponse.json({ content: truncateWithMarker(content, 30000), type: "folder", images });
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
      return NextResponse.json({ content: truncateWithMarker(content, 12000), type: "file" });
    }

    return NextResponse.json(
      { error: "URL is not a recognized Google Doc or Drive link." },
      { status: 400 }
    );
  } catch (err: unknown) {
    console.error("fetch-doc error:", err);
    const { kind, message, raw } = classifyFetchError(err);
    // Auth/config -> needs user action (reconnect); permission/notfound -> client
    // mistake (4xx); ratelimit/network/unknown -> upstream/transient (5xx).
    const statusByKind: Record<string, number> = {
      auth: 401,
      config: 401,
      permission: 403,
      notfound: 404,
      ratelimit: 429,
      network: 504,
      unknown: 502,
    };
    return NextResponse.json(
      { error: message, kind, raw },
      { status: statusByKind[kind] ?? 502 }
    );
  }
}
