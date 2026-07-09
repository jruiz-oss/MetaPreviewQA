import { NextResponse } from "next/server";
import { google } from "googleapis";
import { cookies } from "next/headers";
import { randomBytes } from "crypto";
import { isValidAuthToken } from "@/lib/auth";

const SCOPES = [
  "https://www.googleapis.com/auth/drive.readonly",
  "https://www.googleapis.com/auth/documents.readonly",
];

/**
 * One-time OAuth connect route — used once to capture a long-lived refresh token.
 * After GOOGLE_REFRESH_TOKEN is set in your env vars, this route is unused but harmless.
 */
export async function GET() {
  const cookieStore = await cookies();
  const authCookie = cookieStore.get("qa_auth");
  // Validate the cookie VALUE, not just its presence — a fabricated qa_auth
  // cookie must not be able to start the OAuth flow.
  if (!isValidAuthToken(authCookie?.value)) {
    const base = process.env.NEXT_PUBLIC_BASE_URL ?? "http://localhost:3000";
    return NextResponse.redirect(new URL("/", base));
  }

  const clientId = process.env.GOOGLE_CLIENT_ID!;
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET!;
  const redirectUri = process.env.GOOGLE_REDIRECT_URI!;

  // CSRF `state` token: generated here, echoed back by Google, verified in the
  // callback against this short-lived cookie. Without it, an attacker could
  // drive the OAuth flow with THEIR Google account and get our callback to
  // store THEIR refresh token (token injection / store overwrite).
  const state = randomBytes(32).toString("hex");

  const oAuth2Client = new google.auth.OAuth2(clientId, clientSecret, redirectUri);
  const url = oAuth2Client.generateAuthUrl({
    access_type: "offline",
    prompt: "consent",
    scope: SCOPES,
    state,
  });

  const response = NextResponse.redirect(url);
  response.cookies.set("oauth_state", state, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    maxAge: 60 * 10, // 10 minutes — plenty for the consent screen
    path: "/",
  });
  return response;
}
