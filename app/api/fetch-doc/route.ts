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

async function readDriveFolder(folderId: string): Promise<string> {
  const auth = getOAuthClient();
  const drive = google.drive({ version: "v3", auth });
  const docs = google.docs({ version: "v1", auth });

  // List ALL non-trashed, non-folder files — including shared drives and "Shared with me"
  const listRes = await drive.files.list({
    q: `'${folderId}' in parents and trashed = false and mimeType != 'application/vnd.google-apps.folder'`,
    fields: "files(id, name, mimeType)",
    pageSize: 20,
    supportsAllDrives: true,
    includeItemsFromAllDrives: true,
  });

  const files = listRes.data.files ?? [];
  if (files.length === 0) {
    return "(No files found in this folder.)";
  }

  const sections: string[] = [];

  for (const file of files) {
    if (!file.id || !file.mimeType) continue;

    // Skip image/video/audio files — not readable as text
    if (
      file.mimeType.startsWith("image/") ||
      file.mimeType.startsWith("video/") ||
      file.mimeType.startsWith("audio/")
    ) {
      sections.push(`[File: ${file.name}]\n(Image/media file — skipped)`);
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

  return sections.length > 0
    ? sections.join("\n\n---\n\n")
    : "(No readable content found in this folder.)";
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
      const content = await readDriveFolder(folderId);
      return NextResponse.json({ content: content.slice(0, 12000), type: "folder" });
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
