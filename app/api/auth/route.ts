import { NextResponse } from "next/server";
import { constantTimeEqual } from "@/lib/auth";

export async function POST(request: Request) {
  let password: unknown;
  try {
    ({ password } = await request.json());
  } catch {
    return NextResponse.json({ error: "Bad request" }, { status: 400 });
  }

  const expected = process.env.SITE_PASSWORD;
  // Fail closed if the password isn't configured; use constant-time compare.
  if (
    !expected ||
    typeof password !== "string" ||
    !constantTimeEqual(password, expected)
  ) {
    return NextResponse.json({ error: "Incorrect password" }, { status: 401 });
  }

  const response = NextResponse.json({ ok: true });
  response.cookies.set("qa_auth", process.env.AUTH_TOKEN!, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    maxAge: 60 * 60 * 24 * 30, // 30 days
    path: "/",
  });

  return response;
}
