/**
 * Shared auth helpers.
 *
 * Uses a constant-time string comparison so secret checks don't leak length or
 * content via response timing. Implemented without node:crypto so it works in
 * both the Edge runtime (middleware) and the Node runtime (route handlers).
 */

/** Constant-time equality. Returns false unless both strings are equal. */
export function constantTimeEqual(a: string | undefined, b: string | undefined): boolean {
  if (typeof a !== "string" || typeof b !== "string") return false;
  // Compare a fixed amount of work regardless of where the first difference is.
  // Mixing in the length difference prevents an early-out on length mismatch.
  let mismatch = a.length ^ b.length;
  const max = Math.max(a.length, b.length);
  for (let i = 0; i < max; i++) {
    mismatch |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0);
  }
  return mismatch === 0;
}

/**
 * Returns true if the provided cookie value matches AUTH_TOKEN.
 * Fails closed: if AUTH_TOKEN is unset, nothing authenticates.
 */
export function isValidAuthToken(cookieValue: string | undefined): boolean {
  const expected = process.env.AUTH_TOKEN;
  if (!expected) return false;
  return constantTimeEqual(cookieValue, expected);
}

/** Reads the qa_auth cookie straight off the request's Cookie header. */
function readAuthCookie(request: Request): string | undefined {
  const header = request.headers.get("cookie");
  if (!header) return undefined;
  for (const part of header.split(";")) {
    const [name, ...rest] = part.trim().split("=");
    if (name === "qa_auth") return decodeURIComponent(rest.join("="));
  }
  return undefined;
}

/**
 * Defense-in-depth guard for route handlers. Middleware already gates these,
 * but handlers should not trust that alone. Returns true if authenticated.
 */
export function isAuthedRequest(request: Request): boolean {
  return isValidAuthToken(readAuthCookie(request));
}
