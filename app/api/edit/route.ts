import { NextRequest, NextResponse } from "next/server";
import type { EditRequestBody, EditResponseBody } from "@/lib/types";
import { translateInstruction } from "@/lib/claude";
import { getProvider } from "@/lib/providers";
import { persistImage, persistImageFromUrl } from "@/lib/storage";
import { ensureHighRes } from "@/lib/upscale";

// Claude + image generation can take a while; allow the max on Vercel hobby.
export const maxDuration = 300;

export async function POST(request: NextRequest) {
  let body: EditRequestBody;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Nieprawidłowe żądanie" }, { status: 400 });
  }

  const {
    imageUrl,
    instruction = "",
    provider: requestedProvider,
    quality = "standard",
    claudeModel,
    cameraAngle,
    areas = [],
    maskUrl,
    referenceObjects = [],
    historySummaries,
  } = body;

  const hasAreaDescriptions = areas.some((a) => a.description?.trim());
  const hasReferences = referenceObjects.some((r) => r.imageUrl);
  if (
    !imageUrl ||
    (!instruction.trim() && !hasAreaDescriptions && !cameraAngle && !hasReferences)
  ) {
    return NextResponse.json(
      { error: "Opisz zmianę, zaznacz obszar z opisem albo wybierz kąt kamery." },
      { status: 400 },
    );
  }

  try {
    const provider = getProvider(requestedProvider);
    const refs = referenceObjects.filter((r) => r.imageUrl).slice(0, 4);
    // A real pixel mask (FLUX Fill) always wins over reference images when an
    // area is marked: Fill mechanically preserves everything outside the
    // mask, which a text-only multi-image edit cannot guarantee. Claude still
    // sees the reference photos and folds their material/appearance into the
    // prompt — the image model just doesn't need the reference pixels once a
    // mask is doing the preservation work.
    const useMask = Boolean(maskUrl) && provider.supportsMask && areas.length > 0;

    // 1. Claude turns the Polish instruction (+ areas, refs, camera) into an EN prompt
    const translation = await translateInstruction({
      imageUrl,
      instruction,
      historySummaries: historySummaries ?? [],
      areas,
      cameraAngle: cameraAngle ?? null,
      model: claudeModel,
      maskMode: useMask,
      provider: provider.name,
      referenceObjects: refs,
    });

    // 2. Image model applies the edit
    const result = await provider.generateEdit({
      imageUrl,
      prompt: translation.promptEn,
      quality,
      maskUrl: useMask ? maskUrl : undefined,
      referenceImageUrls: useMask ? undefined : refs.map((r) => r.imageUrl),
    });

    // 3. High tier: bring the output up to the target resolution (short side
    //    ~2160px) unless the model already produced it natively (Gemini 4K).
    let finalBuffer: Buffer;
    let finalMime = result.mimeType;
    let upscaleCost = 0;

    if (result.imageBase64) {
      finalBuffer = Buffer.from(result.imageBase64, "base64");
    } else if (quality === "high" && !result.nativeHighRes) {
      const hires = await ensureHighRes(result.imageUrl!);
      finalBuffer = hires.buffer;
      finalMime = hires.mimeType;
      upscaleCost = hires.extraCostUsd;
    } else {
      const persisted = await persistImageFromUrl(result.imageUrl!);
      const imageCost = result.costUsd;
      const response: EditResponseBody = {
        imageUrl: persisted,
        promptEn: translation.promptEn,
        summaryPl: translation.summaryPl,
        provider: provider.name,
        quality,
        costUsd: {
          claude: translation.costUsd,
          image: imageCost,
          total: translation.costUsd + imageCost,
        },
        claudeTokens: translation.tokens,
      };
      return NextResponse.json(response);
    }

    const persistedUrl = await persistImage(finalBuffer, finalMime);
    const imageCost = result.costUsd + upscaleCost;

    const response: EditResponseBody = {
      imageUrl: persistedUrl,
      promptEn: translation.promptEn,
      summaryPl: translation.summaryPl,
      provider: provider.name,
      quality,
      costUsd: {
        claude: translation.costUsd,
        image: imageCost,
        total: translation.costUsd + imageCost,
      },
      claudeTokens: translation.tokens,
    };
    return NextResponse.json(response);
  } catch (err) {
    const message = err instanceof Error ? err.message : "Nieznany błąd";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
