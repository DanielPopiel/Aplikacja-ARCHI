import { NextRequest, NextResponse } from "next/server";
import { AUTH_COOKIE, sessionTokenFor } from "./lib/auth";

export default async function proxy(request: NextRequest) {
  const password = process.env.APP_PASSWORD;
  // No password configured (e.g. bare local dev) → app is open.
  if (!password) return NextResponse.next();

  const { pathname } = request.nextUrl;
  if (pathname === "/login" || pathname === "/api/auth") {
    return NextResponse.next();
  }

  const cookie = request.cookies.get(AUTH_COOKIE)?.value;
  if (cookie && cookie === (await sessionTokenFor(password))) {
    return NextResponse.next();
  }

  if (pathname.startsWith("/api/")) {
    return NextResponse.json({ error: "Brak autoryzacji" }, { status: 401 });
  }

  const loginUrl = request.nextUrl.clone();
  loginUrl.pathname = "/login";
  loginUrl.search = "";
  return NextResponse.redirect(loginUrl);
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon\\.ico|.*\\.(?:svg|png|jpg|jpeg|ico|webp)$).*)"],
};
