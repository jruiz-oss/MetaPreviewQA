import { NextResponse } from "next/server";
import { google } from "googleapis";
import { setStoredRefreshToken } from "@/lib/token-store";

export async function GET(request: Request) {
  const url = new URL(request.url);
  const code = url.searchParams.get("code");
  const error = url.searchParams.get("error");

  const base = process.env.NEXT_PUBLIC_BASE_URL ?? "http://localhost:3000";

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
      // This can happen if the user already authorized and Google didn't
      // re-issue a refresh token. The connect route uses prompt=consent to
      // prevent this, but handle it gracefully just in case.
      return NextResponse.redirect(`${base}/qa?google_error=no_refresh_token`);
    }

    // Store globally so ALL users get the new token, not just the one who reconnected
    await setStoredRefreshToken(refreshToken);

    return NextResponse.redirect(`${base}/qa?google_connected=1`);
  } catch (err) {
    console.error("Google OAuth callback error:", err);
    return NextResponse.redirect(`${base}/qa?google_error=token_exchange_failed`);
  }
}
