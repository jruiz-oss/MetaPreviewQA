import { NextResponse } from "next/server";
import { google } from "googleapis";
import { cookies } from "next/headers";

const SCOPES = [
  "https://www.googleapis.com/auth/drive.readonly",
  "https://www.googleapis.com/auth/documents.readonly",
];

export async function GET() {
  // Only allow authenticated users
  const cookieStore = await cookies();
  const authCookie = cookieStore.get("qa_auth");
  if (!authCookie) {
    const base = process.env.NEXT_PUBLIC_BASE_URL ?? "http://localhost:3000";
    return NextResponse.redirect(new URL("/", base));
  }

  const clientId = process.env.GOOGLE_CLIENT_ID!;
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET!;
  const redirectUri = process.env.GOOGLE_REDIRECT_URI!;

  const oAuth2Client = new google.auth.OAuth2(clientId, clientSecret, redirectUri);
  const url = oAuth2Client.generateAuthUrl({
    access_type: "offline",
    prompt: "consent", // force Google to return a refresh token every time
    scope: SCOPES,
  });

  return NextResponse.redirect(url);
}
