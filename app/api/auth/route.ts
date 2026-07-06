import { NextRequest, NextResponse } from "next/server";
import { AUTH_COOKIE, sessionTokenFor } from "@/lib/auth";

export async function POST(request: NextRequest) {
  const password = process.env.APP_PASSWORD;
  if (!password) {
    return NextResponse.json({ ok: true, note: "APP_PASSWORD nie jest ustawione — logowanie wyłączone." });
  }

  let body: { password?: string };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Nieprawidłowe żądanie" }, { status: 400 });
  }

  if (body.password !== password) {
    return NextResponse.json({ error: "Nieprawidłowe hasło" }, { status: 401 });
  }

  const response = NextResponse.json({ ok: true });
  response.cookies.set(AUTH_COOKIE, await sessionTokenFor(password), {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    maxAge: 60 * 60 * 24 * 30, // 30 days
    path: "/",
  });
  return response;
}
