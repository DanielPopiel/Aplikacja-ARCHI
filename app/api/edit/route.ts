import { NextRequest, NextResponse } from "next/server";
import type { EditRequestBody, EditResponseBody } from "@/lib/types";
import { translateInstruction } from "@/lib/claude";
import { getProvider } from "@/lib/providers";
import { persistImage } from "@/lib/storage";
import { fetchImageBytes } from "@/lib/image-utils";
import { normalizeToInputSize, readImageDims } from "@/lib/upscale";
import { compositeOutsideMask } from "@/lib/mask-composite";

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

    // FLUX's multi-image model (the only maskless way to use reference photos
    // there) repeatedly leaked the reference's own framing into results,
    // rewriting half the scene. Refuse that combination outright — the mask
    // path is the only reliable one for references on FLUX.
    if (provider.name === "flux" && refs.length > 0 && areas.length === 0) {
      return NextResponse.json(
        {
          error:
            "Przy modelu FLUX obiekt referencyjny wymaga zaznaczenia obszaru, w którym ma się pojawić — edycja przejdzie wtedy przez maskę i reszta zdjęcia jest gwarantowanie nietknięta. Zaznacz obszar albo przełącz model na Nano Banana Pro.",
        },
        { status: 400 },
      );
    }

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

    // 3. Always match the output 1:1 to the edited image's pixel dimensions,
    //    on every quality tier — the aspect_ratio param on the image model
    //    only picks the closest of a handful of presets, which still leaves
    //    a residual mismatch that needs a final exact-size snap. Only "high"
    //    quality pays for a real AuraSR upscale pass when the model's output
    //    is smaller than the input; "standard" gets a free plain resize so
    //    the cheap preview tier stays cheap.
    let finalBuffer: Buffer;
    let finalMime = result.mimeType;
    let upscaleCost = 0;

    const inputDims = await readImageDims(imageUrl);
    if (inputDims) {
      const normalized = await normalizeToInputSize({
        imageUrl: result.imageUrl,
        buffer: result.imageBase64 ? Buffer.from(result.imageBase64, "base64") : undefined,
        mimeType: result.mimeType,
        input: inputDims,
        allowPaidUpscale: quality === "high",
      });
      finalBuffer = normalized.buffer;
      finalMime = normalized.mimeType;
      upscaleCost = normalized.extraCostUsd;

      // Inpainting models regenerate the whole canvas — they only
      // approximate "outside the mask stays the same," they don't guarantee
      // it. Enforce that guarantee ourselves so unrelated background
      // objects/text can never mutate outside the marked area.
      if (useMask && maskUrl) {
        // The composite is a best-effort guarantee, not load-bearing for
        // producing a result: if it throws (bad mask fetch, sharp/memory
        // issue, etc.) fall back to the raw model output rather than
        // failing the whole edit — a slightly-less-guaranteed image beats
        // no image at all.
        try {
          finalBuffer = await compositeOutsideMask({
            editedBuffer: finalBuffer,
            originalUrl: imageUrl,
            maskUrl,
            width: inputDims.width,
            height: inputDims.height,
          });
          finalMime = "image/jpeg";
        } catch (compositeErr) {
          console.error("compositeOutsideMask failed, using raw result:", compositeErr);
        }
      }
    } else if (result.imageBase64) {
      finalBuffer = Buffer.from(result.imageBase64, "base64");
    } else {
      const bytes = await fetchImageBytes(result.imageUrl!);
      finalBuffer = bytes.buffer;
      finalMime = bytes.mimeType;
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
      claudeModel: translation.model,
    };
    return NextResponse.json(response);
  } catch (err) {
    const message = err instanceof Error ? err.message : "Nieznany błąd";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
