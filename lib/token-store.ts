/**
 * Persistent token store backed by Vercel KV.
 * Falls back to the GOOGLE_REFRESH_TOKEN env var if KV is not configured
 * (e.g. local dev without a KV store).
 */
import { kv } from "@vercel/kv";

const KV_KEY = "google_refresh_token";

export async function getStoredRefreshToken(): Promise<string | undefined> {
  try {
    const token = await kv.get<string>(KV_KEY);
    if (token) return token;
  } catch {
    // KV not configured — fall through to env var
  }
  return process.env.GOOGLE_REFRESH_TOKEN ?? undefined;
}

export async function setStoredRefreshToken(token: string): Promise<void> {
  await kv.set(KV_KEY, token);
}
