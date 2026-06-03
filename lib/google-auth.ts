import { google } from "googleapis";

/**
 * Returns an authenticated OAuth2 client.
 *
 * Token resolution order:
 *   1. refreshTokenOverride — passed in from the request's cookie
 *   2. GOOGLE_REFRESH_TOKEN env var — fallback / initial setup
 *
 * Env vars required:
 *   GOOGLE_CLIENT_ID
 *   GOOGLE_CLIENT_SECRET
 *   GOOGLE_REFRESH_TOKEN  (fallback when no cookie is present)
 */
export function getOAuthClient(refreshTokenOverride?: string) {
  const clientId = process.env.GOOGLE_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
  const refreshToken = refreshTokenOverride ?? process.env.GOOGLE_REFRESH_TOKEN;

  if (!clientId || !clientSecret || !refreshToken) {
    throw new Error(
      "Missing Google credentials. Set GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, and GOOGLE_REFRESH_TOKEN in .env.local"
    );
  }

  const auth = new google.auth.OAuth2(clientId, clientSecret);
  auth.setCredentials({ refresh_token: refreshToken });
  return auth;
}
