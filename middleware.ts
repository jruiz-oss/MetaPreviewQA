import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";

export function middleware(request: NextRequest) {
  const { pathname } = request.nextUrl;

  // Allow auth API, login page, and temp setup/debug routes through
  if (
    pathname === "/" ||
    pathname.startsWith("/api/auth") ||
    pathname.startsWith("/api/debug-drive") ||
    pathname.startsWith("/api/google-setup") ||
    pathname.startsWith("/api/google-callback")
  ) {
    return NextResponse.next();
  }

  const authCookie = request.cookies.get("qa_auth");
  const isAuthed = authCookie?.value === process.env.AUTH_TOKEN;

  if (!isAuthed) {
    return NextResponse.redirect(new URL("/", request.url));
  }

  return NextResponse.next();
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};
