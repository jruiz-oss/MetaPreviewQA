/**
 * Login rate limiter: 10 failed attempts per IP per hour.
 *
 * Backed by the same Upstash Redis the token store uses, so the count is
 * shared across all serverless instances (an in-memory Map alone would give
 * each Vercel instance its own counter — nearly useless against brute force).
 * Falls back to a per-instance in-memory Map when Redis isn't configured
 * (local dev), which is fine there.
 *
 * Fixed-window design: INCR the key on each failure, set a 1h TTL when the
 * window starts. Successful login clears the counter.
 */

const MAX_FAILED_ATTEMPTS = 10;
const WINDOW_SECONDS = 60 * 60; // 1 hour

// ── Redis (Upstash REST) ─────────────────────────────────────────────────────

async function redisCmd(parts: string[]): Promise<string | number | null> {
  const url = process.env.KV_REST_API_URL;
  const token = process.env.KV_REST_API_TOKEN;
  if (!url || !token) return null;
  const res = await fetch(`${url}/${parts.map(encodeURIComponent).join("/")}`, {
    headers: { Authorization: `Bearer ${token}` },
    cache: "no-store",
  });
  if (!res.ok) return null;
  const data = await res.json();
  return data.result ?? null;
}

const redisConfigured = () =>
  Boolean(process.env.KV_REST_API_URL && process.env.KV_REST_API_TOKEN);

// ── In-memory fallback (local dev only) ──────────────────────────────────────

const memCounts = new Map<string, { count: number; resetAt: number }>();

function memGet(key: string): number {
  const entry = memCounts.get(key);
  if (!entry || Date.now() > entry.resetAt) {
    memCounts.delete(key);
    return 0;
  }
  return entry.count;
}

function memIncr(key: string): void {
  const entry = memCounts.get(key);
  if (!entry || Date.now() > entry.resetAt) {
    memCounts.set(key, { count: 1, resetAt: Date.now() + WINDOW_SECONDS * 1000 });
  } else {
    entry.count++;
  }
}

// ── Public API ───────────────────────────────────────────────────────────────

/** Client IP from proxy headers (Vercel sets x-forwarded-for). */
export function clientIp(request: Request): string {
  const fwd = request.headers.get("x-forwarded-for");
  // First hop is the real client; later hops are proxies.
  return fwd?.split(",")[0].trim() || "unknown";
}

/** True if this IP has exhausted its failed-attempt budget for the window. */
export async function isRateLimited(ip: string): Promise<boolean> {
  const key = `auth_fail:${ip}`;
  if (redisConfigured()) {
    // Fail OPEN on Redis errors: a Redis outage shouldn't lock everyone out.
    // Brute force still requires the attacker to hit exactly that window.
    const count = await redisCmd(["GET", key]).catch(() => null);
    return Number(count ?? 0) >= MAX_FAILED_ATTEMPTS;
  }
  return memGet(key) >= MAX_FAILED_ATTEMPTS;
}

/** Record one failed login for this IP. Starts the 1h window on first failure. */
export async function recordFailedAttempt(ip: string): Promise<void> {
  const key = `auth_fail:${ip}`;
  if (redisConfigured()) {
    try {
      const count = await redisCmd(["INCR", key]);
      // Set the TTL only when the window starts, so retries can't keep
      // pushing the reset forward indefinitely for other users behind a NAT.
      if (Number(count) === 1) await redisCmd(["EXPIRE", key, String(WINDOW_SECONDS)]);
    } catch {
      // Redis hiccup — skip; next attempt will count.
    }
    return;
  }
  memIncr(key);
}

/** Clear the counter after a successful login. */
export async function clearFailedAttempts(ip: string): Promise<void> {
  const key = `auth_fail:${ip}`;
  if (redisConfigured()) {
    await redisCmd(["DEL", key]).catch(() => {});
    return;
  }
  memCounts.delete(key);
}
