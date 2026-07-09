import { NextResponse } from "next/server";
import { google } from "googleapis";
import { cookies } from "next/headers";
import { setStoredRefreshToken } from "@/lib/token-store";
import { isAuthedRequest, constantTimeEqual } from "@/lib/auth";

/**
 * OAuth callback for the "Reconnect Google" flow. Exchanges the auth code for a
 * fresh refresh token and persists it to the shared token store (Redis) so the
 * new token takes effect immediately across all serverless instances — no
 * redeploy or manual env-var copy required.
 *
 * SECURITY: this route WRITES the shared refresh token, so it must be locked
 * down twice over:
 *   1. qa_auth cookie — only a logged-in user may complete the flow.
 *   2. `state` param must match the oauth_state cookie set by /connect — proves
 *      the flow was started by THIS browser session, not injected by an
 *      attacker completing consent with their own Google account.
 */
export async function GET(request: Request) {
  const url = new URL(request.url);
  const code = url.searchParams.get("code");
  const error = url.searchParams.get("error");

  const base = process.env.NEXT_PUBLIC_BASE_URL ?? "http://localhost:3000";

  // Guard 1: dashboard auth.
  if (!isAuthedRequest(request)) {
    return NextResponse.redirect(new URL("/", base));
  }

  // Guard 2: CSRF state check (constant-time).
  const cookieStore = await cookies();
  const expectedState = cookieStore.get("oauth_state")?.value;
  const returnedState = url.searchParams.get("state");
  if (!expectedState || !constantTimeEqual(returnedState ?? undefined, expectedState)) {
    return NextResponse.redirect(`${base}/qa?google_error=state_mismatch`);
  }

  if (error || !code) {
    return NextResponse.redirect(
      `${base}/qa?google_error=${encodeURIComponent(error ?? "no_code")}`
    );
  }

  const clientId = process.env.GOOGLE_CLIENT_ID!;
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET!;
  const redirectUri = process.env.GOOGLE_REDIRECT_URI!;

  const oAuth2Client = new google.auth.OAuth2(clientId, clientSecret, redirectUri);

  try {
    const { tokens } = await oAuth2Client.getToken(code);
    const refreshToken = tokens.refresh_token;

    if (!refreshToken) {
      return NextResponse.redirect(`${base}/qa?google_error=no_refresh_token`);
    }

    // Persist the new token to the shared store so every serverless instance
    // picks it up immediately. Falls back gracefully if Redis isn't configured.
    await setStoredRefreshToken(refreshToken);

    // One-time use: clear the state cookie so it can't be replayed.
    const response = NextResponse.redirect(`${base}/qa?google_connected=1`);
    response.cookies.set("oauth_state", "", { maxAge: 0, path: "/" });
    return response;
  } catch (err) {
    console.error("Google OAuth callback error:", err);
    return NextResponse.redirect(`${base}/qa?google_error=token_exchange_failed`);
  }
}
