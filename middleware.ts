import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";

export function middleware(request: NextRequest) {
  const { pathname } = request.nextUrl;

  // Allow the auth API and the login page through; everything else requires auth.
  if (pathname === "/" || pathname.startsWith("/api/auth")) {
    return NextResponse.next();
  }

  const expectedToken = process.env.AUTH_TOKEN;
  const authCookie = request.cookies.get("qa_auth");
  // Fail closed: if AUTH_TOKEN is unset, no cookie can ever match (prevents the
  // `undefined === undefined` case that would otherwise authenticate everyone).
  const isAuthed =
    !!expectedToken &&
    !!authCookie?.value &&
    authCookie.value === expectedToken;

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
