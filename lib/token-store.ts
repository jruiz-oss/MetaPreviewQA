/**
 * Persistent token store backed by Upstash Redis.
 * Stores the Google refresh token so all serverless function instances
 * share the same token after a browser reconnect.
 * Falls back to the GOOGLE_REFRESH_TOKEN env var if Redis is not configured.
 */

const REDIS_KEY = "google_refresh_token";

async function redisRequest(method: "GET" | "SET", args: string[]): Promise<string | null> {
  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) return null;

  const res = await fetch(`${url}/${[method, ...args].map(encodeURIComponent).join("/")}`, {
    method: "GET",
    headers: { Authorization: `Bearer ${token}` },
    cache: "no-store",
  });

  if (!res.ok) return null;
  const data = await res.json();
  return data.result ?? null;
}

export async function getStoredRefreshToken(): Promise<string | undefined> {
  try {
    const token = await redisRequest("GET", [REDIS_KEY]);
    if (token) return token;
  } catch {
    // Redis not configured — fall through to env var
  }
  return process.env.GOOGLE_REFRESH_TOKEN ?? undefined;
}

export async function setStoredRefreshToken(token: string): Promise<void> {
  await redisRequest("SET", [REDIS_KEY, token]);
}
