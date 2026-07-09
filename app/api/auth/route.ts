import { NextResponse } from "next/server";
import { constantTimeEqual } from "@/lib/auth";
import { clientIp, isRateLimited, recordFailedAttempt, clearFailedAttempts } from "@/lib/rate-limit";

export async function POST(request: Request) {
  // Brute-force guard: 10 failed attempts per IP per hour (shared via Redis).
  const ip = clientIp(request);
  if (await isRateLimited(ip)) {
    return NextResponse.json(
      { error: "Too many failed attempts. Try again in an hour." },
      { status: 429 }
    );
  }

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
    await recordFailedAttempt(ip);
    return NextResponse.json({ error: "Incorrect password" }, { status: 401 });
  }

  // Successful login clears the counter so a legit user who fat-fingered a few
  // times doesn't stay penalized.
  await clearFailedAttempts(ip);

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
