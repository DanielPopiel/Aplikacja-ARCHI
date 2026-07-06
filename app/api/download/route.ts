import { NextRequest, NextResponse } from "next/server";

export const maxDuration = 60;

/**
 * Proxy download so cross-origin blob URLs work with <a download>.
 * GET /api/download?url=<encoded>&name=<filename>
 */
export async function GET(request: NextRequest) {
  const url = request.nextUrl.searchParams.get("url");
  const name = request.nextUrl.searchParams.get("name") ?? "archi-export.jpg";

  if (!url || !/^https?:\/\//.test(url)) {
    return NextResponse.json({ error: "Nieprawidłowy adres obrazu" }, { status: 400 });
  }

  const res = await fetch(url);
  if (!res.ok || !res.body) {
    return NextResponse.json({ error: `Nie udało się pobrać obrazu (${res.status})` }, { status: 502 });
  }

  const safeName = name.replace(/[^\w.\-]+/g, "_");
  return new NextResponse(res.body, {
    headers: {
      "Content-Type": res.headers.get("content-type") ?? "application/octet-stream",
      "Content-Disposition": `attachment; filename="${safeName}"`,
      "Cache-Control": "no-store",
    },
  });
}
