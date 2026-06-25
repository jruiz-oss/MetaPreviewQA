import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { isValidAuthToken } from "@/lib/auth";

export function middleware(request: NextRequest) {
  const { pathname } = request.nextUrl;

  // Allow the auth API and the login page through; everything else requires auth.
  if (pathname === "/" || pathname.startsWith("/api/auth")) {
    return NextResponse.next();
  }

  // Fail closed (handled inside isValidAuthToken) + constant-time comparison.
  const authCookie = request.cookies.get("qa_auth");
  const isAuthed = isValidAuthToken(authCookie?.value);

  if (!isAuthed) {
    return NextResponse.redirect(new URL("/", request.url));
  }

  return NextResponse.next();
}

export const config = {
  // Also exempt public image assets (logo, icons): without this, the login
  // page's <img src="/vera-wordmark-transparent.png"> was caught by the
  // middleware pre-auth and redirected to "/", rendering as a broken image.
  matcher: [
    "/((?!_next/static|_next/image|favicon.ico|.*\\.(?:png|jpg|jpeg|gif|svg|webp|ico)$).*)",
  ],
};
