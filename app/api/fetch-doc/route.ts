import { NextResponse } from "next/server";
import { google } from "googleapis";
import { getOAuthClient } from "@/lib/google-auth";

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

async function readDriveFolder(folderId: string): Promise<string> {
  const auth = getOAuthClient();
  const drive = google.drive({ version: "v3", auth });
  const docs = google.docs({ version: "v1", auth });

  // List files in the folder — only Google Docs and text files
  const listRes = await drive.files.list({
    q: `'${folderId}' in parents and trashed = false and (mimeType = 'application/vnd.google-apps.document' or mimeType = 'text/plain')`,
    fields: "files(id, name, mimeType)",
    pageSize: 10,
  });

  const files = listRes.data.files ?? [];
  if (files.length === 0) {
    return "(No readable Google Docs found in this folder.)";
  }

  const sections: string[] = [];

  for (const file of files) {
    if (!file.id) continue;
    try {
      let content = "";
      if (file.mimeType === "application/vnd.google-apps.document") {
        const docRes = await docs.documents.get({ documentId: file.id });
        const text: string[] = [];
        for (const block of docRes.data.body?.content ?? []) {
          if (block.paragraph) {
            for (const el of block.paragraph.elements ?? []) {
              if (el.textRun?.content) text.push(el.textRun.content);
            }
          }
        }
        content = text.join("").trim();
      } else {
        // Plain text — export directly
        const exportRes = await drive.files.get(
          { fileId: file.id, alt: "media" },
          { responseType: "text" }
        );
        content = String(exportRes.data).trim();
      }
      if (content) {
        sections.push(`[File: ${file.name}]\n${content}`);
      }
    } catch {
      sections.push(`[File: ${file.name}]\n(Could not read this file.)`);
    }
  }

  return sections.join("\n\n---\n\n");
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
