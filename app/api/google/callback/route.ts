import { NextResponse } from "next/server";
import { google } from "googleapis";

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

    const response = NextResponse.redirect(`${base}/qa?google_connected=1`);
    response.cookies.set("google_refresh_token", refreshToken, {
      httpOnly: true,
      secure: process.env.NODE_ENV === "production",
      sameSite: "lax",
      maxAge: 60 * 60 * 24 * 365, // 1 year
      path: "/",
    });
    return response;
  } catch (err) {
    console.error("Google OAuth callback error:", err);
    return NextResponse.redirect(`${base}/qa?google_error=token_exchange_failed`);
  }
}
