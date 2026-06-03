/**
 * Persistent token store backed by Vercel Blob.
 * Stores the Google refresh token as a small blob file so all serverless
 * function instances share the same token after a browser reconnect.
 * Falls back to the GOOGLE_REFRESH_TOKEN env var if Blob is not configured.
 */
import { put, head, del } from "@vercel/blob";

const BLOB_PATHNAME = "vera/google_refresh_token.txt";

export async function getStoredRefreshToken(): Promise<string | undefined> {
  try {
    // Check if the blob exists
    const existing = await head(BLOB_PATHNAME, {
      token: process.env.BLOB_READ_WRITE_TOKEN,
    }).catch(() => null);

    if (existing?.url) {
      const res = await fetch(existing.url, { cache: "no-store" });
      if (res.ok) {
        const token = (await res.text()).trim();
        if (token) return token;
      }
    }
  } catch {
    // Blob not configured — fall through to env var
  }
  return process.env.GOOGLE_REFRESH_TOKEN ?? undefined;
}

export async function setStoredRefreshToken(token: string): Promise<void> {
  // Delete old blob first (put with same pathname creates a new URL otherwise)
  await del(BLOB_PATHNAME, {
    token: process.env.BLOB_READ_WRITE_TOKEN,
  }).catch(() => null);

  await put(BLOB_PATHNAME, token, {
    access: "public",
    token: process.env.BLOB_READ_WRITE_TOKEN,
    addRandomSuffix: false,
  });
}
