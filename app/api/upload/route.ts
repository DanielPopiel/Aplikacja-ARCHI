import { NextRequest, NextResponse } from "next/server";
import { persistImage } from "@/lib/storage";

export const maxDuration = 60;

export async function POST(request: NextRequest) {
  try {
    const formData = await request.formData();
    const file = formData.get("file");
    if (!(file instanceof File)) {
      return NextResponse.json({ error: "Brak pliku w żądaniu" }, { status: 400 });
    }
    if (!file.type.startsWith("image/")) {
      return NextResponse.json({ error: "Plik nie jest obrazem" }, { status: 400 });
    }

    const buffer = Buffer.from(await file.arrayBuffer());
    const url = await persistImage(buffer, file.type);
    return NextResponse.json({ url });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Nieznany błąd";
    return NextResponse.json({ error: `Upload nie powiódł się: ${message}` }, { status: 500 });
  }
}
