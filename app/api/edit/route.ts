import { NextRequest, NextResponse } from "next/server";
import type { EditRequestBody, EditResponseBody } from "@/lib/types";
import type { GenerateEditResult } from "@/lib/providers/types";
import { translateInstruction } from "@/lib/claude";
import { getProvider } from "@/lib/providers";
import { eraseMasked } from "@/lib/providers/flux-kontext";
import { persistImage } from "@/lib/storage";
import { fetchImageBytes } from "@/lib/image-utils";
import { normalizeToInputSize, readImageDims } from "@/lib/upscale";
import { compositeOutsideMask } from "@/lib/mask-composite";
import { computeCropRect, cropImage, pasteRegion } from "@/lib/mask-crop";
import { refineMaskWithSam, SAM_COST_USD } from "@/lib/sam";
import { meanAbsDiff, NO_CHANGE_THRESHOLD } from "@/lib/image-diff";

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

    // Regional editing is OUR mechanism (crop the region → edit the crop →
    // paste back → mechanically restore every pixel outside the mask), so it
    // works with ANY editor model, not just ones with native inpainting.
    // Whether to use it depends only on there being a marked area + a mask.
    const useMask = Boolean(maskUrl) && areas.length > 0;

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

    const inputDims = await readImageDims(imageUrl);

    // 1b. Turn the rough rectangle mask into a pixel-accurate object mask with
    //     SAM 3 so the edit only touches the actual object, not the wall/floor
    //     the rectangle happened to include. Falls back to the rectangle mask
    //     on any failure — a pure quality upgrade that can never block an edit.
    let effectiveMaskUrl = maskUrl;
    let samCost = 0;
    if (useMask && maskUrl && inputDims && process.env.SAM_DISABLED !== "1") {
      const refined = await refineMaskWithSam(imageUrl, areas, inputDims);
      if (refined) {
        effectiveMaskUrl = refined;
        samCost = SAM_COST_USD;
      }
    }

    // Crop-and-edit: when the marked areas are a small/thin slice of the
    // image, editors degrade (a thin band across an interior photo reads to
    // them as a measurement diagram / staging spot). Editing a padded crop
    // instead shows the model the edit area at a large relative scale.
    // Removals skip this: the prompt-less eraser is robust at full frame.
    const cropRect =
      useMask && effectiveMaskUrl && inputDims && translation.editType !== "removal"
        ? computeCropRect(areas, inputDims)
        : null;

    // 2. Apply the edit.
    let result: GenerateEditResult;
    if (useMask && effectiveMaskUrl && translation.editType === "removal") {
      // Pure removal → shared Bria eraser at full frame, whatever editor
      // model is selected (a dedicated eraser can't redraw the object).
      result = await eraseMasked(imageUrl, effectiveMaskUrl);
    } else if (cropRect) {
      // Masked edit → edit just the cropped region; the mask boundary is
      // enforced afterwards by the outside-mask composite.
      const cropUrl = await cropImage(imageUrl, cropRect);
      result = await provider.generateEdit({
        prompt: translation.promptEn,
        quality,
        imageUrl: cropUrl,
        editType: translation.editType,
      });
    } else {
      // Whole-image edit (no area, or area covers most of the frame).
      // References go in natively for models that accept them.
      result = await provider.generateEdit({
        prompt: translation.promptEn,
        quality,
        imageUrl,
        referenceImageUrls: useMask ? undefined : refs.map((r) => r.imageUrl),
        editType: translation.editType,
      });
    }

    // 3. Always match the output 1:1 to the edited image's pixel dimensions
    //    (crop mode: to the crop's dimensions, then paste back), on every
    //    quality tier — the aspect_ratio param on the image model only picks
    //    the closest of a handful of presets, which still leaves a residual
    //    mismatch that needs a final exact-size snap. Only "high" quality
    //    pays for a real AuraSR upscale pass when the model's output is
    //    smaller than the input; "standard" gets a free plain resize so the
    //    cheap preview tier stays cheap.
    let finalBuffer: Buffer;
    let finalMime = result.mimeType;
    let upscaleCost = 0;

    if (inputDims) {
      const targetDims = cropRect
        ? { width: cropRect.width, height: cropRect.height }
        : inputDims;
      const normalized = await normalizeToInputSize({
        imageUrl: result.imageUrl,
        buffer: result.imageBase64 ? Buffer.from(result.imageBase64, "base64") : undefined,
        mimeType: result.mimeType,
        input: targetDims,
        allowPaidUpscale: quality === "high",
      });
      finalBuffer = normalized.buffer;
      finalMime = normalized.mimeType;
      upscaleCost = normalized.extraCostUsd;

      if (cropRect) {
        finalBuffer = await pasteRegion(imageUrl, finalBuffer, cropRect);
        finalMime = "image/jpeg";
      }

      // Inpainting models regenerate the whole canvas — they only
      // approximate "outside the mask stays the same," they don't guarantee
      // it. Enforce that guarantee ourselves so unrelated background
      // objects/text can never mutate outside the marked area.
      if (useMask && effectiveMaskUrl) {
        // The composite is a best-effort guarantee, not load-bearing for
        // producing a result: if it throws (bad mask fetch, sharp/memory
        // issue, etc.) fall back to the raw model output rather than
        // failing the whole edit — a slightly-less-guaranteed image beats
        // no image at all.
        try {
          finalBuffer = await compositeOutsideMask({
            editedBuffer: finalBuffer,
            originalUrl: imageUrl,
            maskUrl: effectiveMaskUrl,
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

    // No-op detection: warn when the result is near-identical to the input,
    // so a "model changed nothing" outcome is named instead of leaving the
    // user squinting at two identical images they paid for.
    let warning: string | undefined;
    try {
      const diff = await meanAbsDiff(imageUrl, finalBuffer);
      if (diff < NO_CHANGE_THRESHOLD) {
        warning =
          "Model nie wprowadził zauważalnej zmiany — wynik jest niemal identyczny z oryginałem. " +
          "Opisz wyraźnie, czym nowy element ma się RÓŻNIĆ od obecnego (np. wyższa listwa, płaski profil), " +
          "albo użyj zdjęcia referencyjnego pokazującego obiekt w szerszym kontekście.";
      }
    } catch {
      /* diff is best-effort */
    }

    const persistedUrl = await persistImage(finalBuffer, finalMime);
    const imageCost = result.costUsd + upscaleCost + samCost;

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
      warning,
    };
    return NextResponse.json(response);
  } catch (err) {
    const message = err instanceof Error ? err.message : "Nieznany błąd";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
