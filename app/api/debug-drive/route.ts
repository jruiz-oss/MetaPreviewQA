import { NextResponse } from "next/server";
import { google } from "googleapis";
import { getOAuthClient } from "@/lib/google-auth";

export async function POST(request: Request) {
  const { folderId } = await request.json();
  if (!folderId) {
    return NextResponse.json({ error: "No folderId provided" }, { status: 400 });
  }

  try {
    const auth = getOAuthClient();
    const drive = google.drive({ version: "v3", auth });

    // 1. Who is the authenticated user?
    const aboutRes = await drive.about.get({ fields: "user" });
    const authedUser = aboutRes.data.user?.emailAddress ?? "unknown";

    // 2. Can we fetch the folder itself?
    let folderMeta: Record<string, unknown> = {};
    try {
      const folderRes = await drive.files.get({
        fileId: folderId,
        fields: "id, name, mimeType, owners, shared, sharingUser",
        supportsAllDrives: true,
      });
      folderMeta = folderRes.data as Record<string, unknown>;
    } catch (e) {
      folderMeta = { error: e instanceof Error ? e.message : String(e) };
    }

    // 3. List files — try each corpora combination
    const results: Record<string, unknown> = {};

    for (const corpora of ["user", "allDrives"] as const) {
      try {
        const res = await drive.files.list({
          q: `'${folderId}' in parents and trashed = false`,
          fields: "files(id, name, mimeType)",
          pageSize: 10,
          supportsAllDrives: true,
          includeItemsFromAllDrives: true,
          corpora,
        });
        results[corpora] = res.data.files ?? [];
      } catch (e) {
        results[corpora] = { error: e instanceof Error ? e.message : String(e) };
      }
    }

    return NextResponse.json({
      authedUser,
      folderMeta,
      fileListResults: results,
    });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 500 }
    );
  }
}
