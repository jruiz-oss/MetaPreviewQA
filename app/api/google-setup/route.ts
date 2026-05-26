import { NextResponse } from "next/server";
import { google } from "googleapis";

export async function GET() {
  const oauth2Client = new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET,
    "https://meta-preview-qa.vercel.app/api/google-callback"
  );

  const url = oauth2Client.generateAuthUrl({
    access_type: "offline",
    prompt: "consent", // forces Google to return a refresh token
    scope: [
      "https://www.googleapis.com/auth/drive.readonly",
      "https://www.googleapis.com/auth/documents.readonly",
    ],
  });

  return NextResponse.redirect(url);
}
