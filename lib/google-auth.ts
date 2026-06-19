import { google } from "googleapis";

/**
 * Returns an OAuth2 client authenticated with a long-lived refresh token.
 *
 * The refresh token is stored permanently as an environment variable — it
 * never expires unless manually revoked, so no reconnect flow is needed.
 *
 * Required env vars:
 *   GOOGLE_CLIENT_ID
 *   GOOGLE_CLIENT_SECRET
 *   GOOGLE_REFRESH_TOKEN  ← get this once via the OAuth flow, then hardcode it
 *
 * To get the refresh token for the first time:
 *   1. Run the app locally (npm run dev)
 *   2. Log in and click "Connect Google" — complete the consent screen
 *   3. The token is printed to the server console (we log it below)
 *   4. Copy it into GOOGLE_REFRESH_TOKEN in your Vercel env vars
 *   5. Remove the connect/callback routes once confirmed working
 */
export function getGoogleAuth() {
  const clientId = process.env.GOOGLE_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
  const refreshToken = process.env.GOOGLE_REFRESH_TOKEN;

  if (!clientId || !clientSecret || !refreshToken) {
    throw new Error(
      "Missing Google credentials. Set GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, " +
      "and GOOGLE_REFRESH_TOKEN in your environment variables."
    );
  }

  const auth = new google.auth.OAuth2(clientId, clientSecret);
  auth.setCredentials({ refresh_token: refreshToken });
  return auth;
}

// Alias so existing call sites in fetch-doc and qa routes work without changes.
export function getOAuthClient(_refreshTokenOverride?: string) {
  return getGoogleAuth();
}
