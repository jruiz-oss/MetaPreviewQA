import { NextResponse } from "next/server";
import { google } from "googleapis";

/**
 * One-time OAuth callback to capture a long-lived refresh token.
 * After you've copied GOOGLE_REFRESH_TOKEN into your env vars and confirmed
 * the app works, this route can stay as-is (it just won't be linked anywhere).
 */
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
      return NextResponse.redirect(`${base}/qa?google_error=no_refresh_token`);
    }

    // ⬇️ COPY THIS VALUE into GOOGLE_REFRESH_TOKEN in your env vars / Vercel dashboard
    console.log("=== GOOGLE REFRESH TOKEN (copy into env vars) ===");
    console.log(refreshToken);
    console.log("=================================================");

    return NextResponse.redirect(`${base}/qa?google_connected=1`);
  } catch (err) {
    console.error("Google OAuth callback error:", err);
    return NextResponse.redirect(`${base}/qa?google_error=token_exchange_failed`);
  }
}
