import { NextResponse } from "next/server";
import { google } from "googleapis";

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const code = searchParams.get("code");
  const error = searchParams.get("error");

  if (error) {
    return new NextResponse(`<html><body><h2>Error: ${error}</h2></body></html>`, {
      headers: { "Content-Type": "text/html" },
    });
  }

  if (!code) {
    return new NextResponse(`<html><body><h2>No code returned from Google.</h2></body></html>`, {
      headers: { "Content-Type": "text/html" },
    });
  }

  const oauth2Client = new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET,
    "https://meta-preview-qa.vercel.app/api/google-callback"
  );

  const { tokens } = await oauth2Client.getToken(code);
  const refreshToken = tokens.refresh_token;

  if (!refreshToken) {
    return new NextResponse(
      `<html><body>
        <h2>No refresh token returned.</h2>
        <p>This usually means this Google account already authorized the app before.
        Go to <a href="https://myaccount.google.com/permissions">myaccount.google.com/permissions</a>,
        revoke access for this app, then try <a href="/api/google-setup">the setup flow</a> again.</p>
      </body></html>`,
      { headers: { "Content-Type": "text/html" } }
    );
  }

  return new NextResponse(
    `<html><body style="font-family:monospace;padding:2rem;max-width:800px">
      <h2>✅ Got your refresh token</h2>
      <p>Copy the value below and set it as <strong>GOOGLE_REFRESH_TOKEN</strong> in your Vercel environment variables.</p>
      <textarea rows="4" style="width:100%;padding:1rem;font-size:14px;border:1px solid #ccc;border-radius:6px" onclick="this.select()">${refreshToken}</textarea>
      <p style="margin-top:1rem;color:#666">After updating the env var in Vercel, redeploy the project and delete the <code>/api/google-setup</code> and <code>/api/google-callback</code> routes.</p>
    </body></html>`,
    { headers: { "Content-Type": "text/html" } }
  );
}
