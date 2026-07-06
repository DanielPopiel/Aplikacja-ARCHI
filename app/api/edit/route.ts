import { NextRequest, NextResponse } from "next/server";
import type { EditRequestBody, EditResponseBody } from "@/lib/types";
import { translateInstruction } from "@/lib/claude";
import { getProvider } from "@/lib/providers";
import { persistImage, persistImageFromUrl } from "@/lib/storage";

// Claude + image generation can take a while; allow the max on Vercel hobby.
export const maxDuration = 300;

export async function POST(request: NextRequest) {
  let body: EditRequestBody;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Nieprawidłowe żądanie" }, { status: 400 });
  }

  const { imageUrl, instruction, provider: requestedProvider, historySummaries } = body;
  if (!imageUrl || !instruction?.trim()) {
    return NextResponse.json({ error: "Wymagane pola: imageUrl, instruction" }, { status: 400 });
  }

  try {
    // 1. Claude (Fable) turns the Polish instruction into an optimized English prompt
    const translation = await translateInstruction(
      imageUrl,
      instruction.trim(),
      historySummaries ?? [],
    );

    // 2. Image model applies the edit
    const provider = getProvider(requestedProvider);
    const result = await provider.generateEdit({ imageUrl, prompt: translation.promptEn });

    // 3. Persist the result in our own storage (provider CDN URLs can expire)
    const persistedUrl = result.imageBase64
      ? await persistImage(Buffer.from(result.imageBase64, "base64"), result.mimeType)
      : await persistImageFromUrl(result.imageUrl!);

    const response: EditResponseBody = {
      imageUrl: persistedUrl,
      promptEn: translation.promptEn,
      summaryPl: translation.summaryPl,
      provider: provider.name,
      costUsd: {
        claude: translation.costUsd,
        image: result.costUsd,
        total: translation.costUsd + result.costUsd,
      },
    };
    return NextResponse.json(response);
  } catch (err) {
    const message = err instanceof Error ? err.message : "Nieznany błąd";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
