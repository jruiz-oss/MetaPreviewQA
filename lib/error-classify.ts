// Maps an arbitrary thrown error (Google API client, OAuth, network, etc.) to a
// stable `kind` plus a human-friendly message. This is intentionally
// signature-based, NOT a hardcode-everything-to-"reconnect" switch: only errors
// whose signatures we actually recognize get a friendly label. Anything else
// falls through to `kind: "unknown"` and keeps the raw message, so an unrelated
// failure (404, permission, empty file, timeout) is never mislabeled as an auth
// problem.

export type FetchErrorKind =
  | "auth" // OAuth token expired/revoked/invalid — needs Reconnect Google
  | "config" // server missing client id/secret/refresh token
  | "permission" // token is fine, but this file/folder isn't shared with us
  | "notfound" // link is wrong or the file was deleted
  | "ratelimit" // Google is throttling us — transient, retry later
  | "network" // timeout / fetch failure — transient
  | "unknown"; // anything we don't recognize — show raw message

export interface ClassifiedError {
  kind: FetchErrorKind;
  /** Friendly, user-facing message. */
  message: string;
  /** Original error message, for logs / debugging. */
  raw: string;
}

function pullMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === "string") return err;
  try {
    return JSON.stringify(err);
  } catch {
    return "Unknown error";
  }
}

// googleapis errors usually carry an HTTP status on `.code` (number) and the
// OAuth token endpoint returns `{ error: "invalid_grant", ... }` which the
// client surfaces in the message and/or `.response.data.error`.
function pullStatus(err: unknown): number | undefined {
  const e = err as { code?: unknown; status?: unknown; response?: { status?: unknown } };
  const candidates = [e?.code, e?.status, e?.response?.status];
  for (const c of candidates) {
    const n = typeof c === "string" ? parseInt(c, 10) : c;
    if (typeof n === "number" && !Number.isNaN(n)) return n;
  }
  return undefined;
}

export function classifyFetchError(err: unknown): ClassifiedError {
  const raw = pullMessage(err);
  const m = raw.toLowerCase();
  const status = pullStatus(err);

  // 1. Server isn't configured at all (no client id/secret or no token yet).
  if (m.includes("missing google") || m.includes("credentials")) {
    return {
      kind: "config",
      message:
        "Google isn't connected on the server yet. Click “Reconnect Google” and sign in with your personal Commit email to authorize access.",
      raw,
    };
  }

  // 2. OAuth token problems — the canonical signatures. `invalid_grant` means
    //    the refresh token expired or was revoked; the others are client/scope
    //    level. All are fixed by reconnecting.
  const authSignatures = [
    "invalid_grant",
    "invalid_token",
    "invalid_client",
    "unauthorized_client",
    "token has been expired or revoked",
    "no refresh token",
    "no access, refresh token",
  ];
  if (authSignatures.some((s) => m.includes(s)) || status === 401) {
    return {
      kind: "auth",
      message:
        "Google authorization expired. Click “Reconnect Google” and sign in with your personal Commit email (not a shared or client account) to restore access.",
      raw,
    };
  }

  // 3. Token is valid but we don't have rights to this specific item.
  if (status === 403 || m.includes("permission") || m.includes("insufficient")) {
    return {
      kind: "permission",
      message:
        "This file isn’t shared with the connected Google account. Share it (or check the link) and retry.",
      raw,
    };
  }

  // 4. Wrong link or deleted file.
  if (status === 404 || m.includes("not found") || m.includes("notfound")) {
    return {
      kind: "notfound",
      message: "Couldn’t find this file — the link may be wrong or the file was deleted.",
      raw,
    };
  }

  // 5. Throttling — transient.
  if (status === 429 || m.includes("rate limit") || m.includes("quota")) {
    return {
      kind: "ratelimit",
      message: "Google is rate-limiting requests. Wait a moment and retry.",
      raw,
    };
  }

  // 6. Network/timeouts — transient.
  if (
    m.includes("timeout") ||
    m.includes("timed out") ||
    m.includes("etimedout") ||
    m.includes("econnreset") ||
    m.includes("network") ||
    m.includes("fetch failed")
  ) {
    return {
      kind: "network",
      message: "Network issue reaching Google. Retry in a moment.",
      raw,
    };
  }

  // 7. Anything else: don't guess. Show the real message.
  return { kind: "unknown", message: `Could not read this link: ${raw}`, raw };
}
