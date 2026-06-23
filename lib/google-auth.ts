import { google } from "googleapis";
import { getStoredRefreshToken } from "./token-store";

/**
 * Returns an OAuth2 client authenticated with the current Google refresh token.
 *
 * The token is read from the shared token store (Upstash Redis) so that a
 * reconnect from the dashboard takes effect immediately across all serverless
 * instances. If Redis is not configured, it falls back to the
 * GOOGLE_REFRESH_TOKEN env var.
 *
 * NOTE: Refresh tokens DO expire (~7 days) while the Google OAuth consent
 * screen is in "Testing" mode — that produces the `invalid_grant` errors seen
 * in the dashboard. The durable fix is to publish the consent screen to
 * "Production" in Google Cloud Console. Until then, use the "Reconnect Google"
 * button to mint a fresh token.
 *
 * Required config:
 *   GOOGLE_CLIENT_ID
 *   GOOGLE_CLIENT_SECRET
 *   a refresh token in Redis (preferred) or GOOGLE_REFRESH_TOKEN (fallback)
 */
export async function getGoogleAuth() {
  const clientId = process.env.GOOGLE_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
  const refreshToken = await getStoredRefreshToken();

  if (!clientId || !clientSecret || !refreshToken) {
    throw new Error(
      "Missing Google credentials. Set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET, " +
      "and connect Google (Reconnect Google button) or set GOOGLE_REFRESH_TOKEN."
    );
  }

  const auth = new google.auth.OAuth2(clientId, clientSecret);
  auth.setCredentials({ refresh_token: refreshToken });
  return auth;
}

// Alias so existing call sites in fetch-doc and qa routes work without changes.
export async function getOAuthClient(_refreshTokenOverride?: string) {
  return getGoogleAuth();
}
