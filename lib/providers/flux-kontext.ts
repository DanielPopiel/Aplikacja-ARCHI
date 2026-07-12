import sharp from "sharp";
import type { GenerateEditParams, GenerateEditResult, ImageEditProvider } from "./types";
import { fetchImageBytes } from "../image-utils";

// Model endpoints on fal.ai, overridable via env.
const MODEL_STANDARD = process.env.FAL_MODEL_STANDARD ?? "fal-ai/flux-pro/kontext";
const MODEL_HIGH = process.env.FAL_MODEL_HIGH ?? process.env.FAL_MODEL ?? "fal-ai/flux-pro/kontext/max";
const MODEL_FILL = process.env.FAL_MODEL_FILL ?? "fal-ai/flux-pro/v1/fill";
const MODEL_MULTI = process.env.FAL_MODEL_MULTI ?? "fal-ai/flux-pro/kontext/max/multi";
const MODEL_ERASER = process.env.FAL_MODEL_ERASER ?? "fal-ai/bria/eraser";

// Per-image costs shown in the cost counter (USD).
const COST_STANDARD = Number(process.env.FLUX_STANDARD_COST_USD ?? "0.04");
const COST_HIGH = Number(process.env.FLUX_COST_USD ?? "0.08");
const COST_FILL = Number(process.env.FLUX_FILL_COST_USD ?? "0.05");
const COST_MULTI = Number(process.env.FLUX_MULTI_COST_USD ?? "0.08");
const COST_ERASER = Number(process.env.BRIA_ERASER_COST_USD ?? "0.04");

interface FalImage {
  url: string;
  content_type?: string;
}

interface FalRunResponse {
  images?: FalImage[];
  image?: FalImage;
  detail?: unknown;
}

// fal.run (sync) enforces a per-account concurrency limit and returns 429
// when parallel requests exceed it — which our model-comparison feature does
// by design (N variants at once). fal's docs say to retry raw HTTP calls
// with exponential backoff, which their own SDK also does.
const RETRYABLE_STATUS = new Set([429, 500, 502, 503]);
const MAX_ATTEMPTS = 4;

export async function callFal(model: string, input: Record<string, unknown>): Promise<FalImage> {
  const apiKey = process.env.FAL_KEY;
  if (!apiKey) {
    throw new Error("Brak klucza FAL_KEY w zmiennych środowiskowych.");
  }

  let lastError = "";
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    if (attempt > 0) {
      const delay = 1500 * 2 ** (attempt - 1) + Math.random() * 500;
      await new Promise((r) => setTimeout(r, delay));
    }

    const res = await fetch(`https://fal.run/${model}`, {
      method: "POST",
      headers: {
        Authorization: `Key ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(input),
    });

    if (res.ok) {
      const data = (await res.json()) as FalRunResponse;
      const image = data.images?.[0] ?? data.image;
      if (!image?.url) {
        throw new Error(`fal.ai nie zwrócił obrazu: ${JSON.stringify(data).slice(0, 500)}`);
      }
      return image;
    }

    const body = await res.text();
    lastError = `fal.ai (${model}) zwrócił błąd ${res.status}: ${body.slice(0, 500)}`;
    if (!RETRYABLE_STATUS.has(res.status)) break;
  }
  throw new Error(lastError);
}

export const ASPECT_RATIOS: Array<{ value: string; ratio: number }> = [
  { value: "21:9", ratio: 21 / 9 },
  { value: "16:9", ratio: 16 / 9 },
  { value: "4:3", ratio: 4 / 3 },
  { value: "3:2", ratio: 3 / 2 },
  { value: "1:1", ratio: 1 },
  { value: "2:3", ratio: 2 / 3 },
  { value: "3:4", ratio: 3 / 4 },
  { value: "9:16", ratio: 9 / 16 },
  { value: "9:21", ratio: 9 / 21 },
];

async function closestAspectRatio(imageUrl: string): Promise<string | undefined> {
  try {
    const { buffer } = await fetchImageBytes(imageUrl);
    const meta = await sharp(buffer).metadata();
    if (!meta.width || !meta.height) return undefined;
    const ratio = meta.width / meta.height;
    return ASPECT_RATIOS.reduce((best, cur) =>
      Math.abs(cur.ratio - ratio) < Math.abs(best.ratio - ratio) ? cur : best,
    ).value;
  } catch {
    return undefined;
  }
}

/**
 * FLUX via fal.ai:
 * - edits without mask → FLUX.1 Kontext (pro for drafts, max for final quality),
 * - pure removals with a marked area → Bria Eraser (prompt-less background
 *   reconstruction — can't redraw the object or typeset prompt words),
 * - other edits with a marked area → also Kontext, run on the padded crop
 *   the server prepared; the mask boundary is enforced afterwards by the
 *   server-side pixel composite (FLUX Fill hallucinated props/badges inside
 *   masks; kept only behind FAL_MASKED_MODE=fill),
 * - edits with reference objects → Kontext Max Multi (main image + references).
 */
export const fluxKontextProvider: ImageEditProvider = {
  name: "flux",
  supportsMask: true,

  async generateEdit({
    imageUrl,
    prompt,
    quality,
    maskUrl,
    referenceImageUrls,
    editType,
  }: GenerateEditParams): Promise<GenerateEditResult> {
    if (referenceImageUrls && referenceImageUrls.length > 0) {
      // Multi-image editing: the main scene first, then the reference objects.
      const aspectRatio = await closestAspectRatio(imageUrl);
      const image = await callFal(MODEL_MULTI, {
        prompt,
        image_urls: [imageUrl, ...referenceImageUrls],
        ...(aspectRatio ? { aspect_ratio: aspectRatio } : {}),
        output_format: "jpeg",
        safety_tolerance: "2",
      });
      return {
        imageUrl: image.url,
        mimeType: image.content_type ?? "image/jpeg",
        costUsd: COST_MULTI,
        model: MODEL_MULTI,
      };
    }

    if (maskUrl) {
      // Pure removals go to a dedicated eraser: it takes NO prompt and only
      // reconstructs background inside the mask, so it cannot "draw the
      // removed object back" or typeset prompt words — both confirmed FLUX
      // Fill failure modes. Fill remains a generative inpainter and wants to
      // draw *something* in the mask, which is wrong for removal.
      if (editType === "removal") {
        const image = await callFal(MODEL_ERASER, {
          image_url: imageUrl,
          mask_url: maskUrl,
          mask_type: "manual",
        });
        return {
          imageUrl: image.url,
          mimeType: image.content_type ?? "image/jpeg",
          costUsd: COST_ERASER,
          model: MODEL_ERASER,
        };
      }

      // Other masked edits: FLUX Fill proved unusable — even with clean
      // positive prompts and the crop trick it kept injecting staging props
      // (vases, baskets) and fake badges INSIDE wide masks (genre prior:
      // "empty floor along a wall wants decor"). Kontext is an instruction-
      // following EDITOR, not a void-filler — it changes what the prompt
      // names and leaves the rest alone. The mask boundary itself is
      // enforced mechanically by the server-side outside-mask composite, so
      // the generator doesn't need to see the mask at all. Fill stays
      // available for comparison via FAL_MASKED_MODE=fill.
      if (process.env.FAL_MASKED_MODE === "fill") {
        const image = await callFal(MODEL_FILL, {
          prompt,
          image_url: imageUrl,
          mask_url: maskUrl,
          output_format: "jpeg",
          safety_tolerance: "2",
        });
        return {
          imageUrl: image.url,
          mimeType: image.content_type ?? "image/jpeg",
          costUsd: COST_FILL,
          model: MODEL_FILL,
        };
      }
      // ...else fall through to the plain Kontext path below.
    }

    // Plain Kontext calls are txt+image-conditioned generation with an
    // undocumented default canvas — without an explicit aspect_ratio the
    // output can drift from the input's proportions, which then made the
    // image visibly "jump" in size when flipping through edit history.
    const model = quality === "high" ? MODEL_HIGH : MODEL_STANDARD;
    const aspectRatio = await closestAspectRatio(imageUrl);
    const image = await callFal(model, {
      prompt,
      image_url: imageUrl,
      ...(aspectRatio ? { aspect_ratio: aspectRatio } : {}),
      output_format: "jpeg",
      safety_tolerance: "2",
    });
    return {
      imageUrl: image.url,
      mimeType: image.content_type ?? "image/jpeg",
      costUsd: quality === "high" ? COST_HIGH : COST_STANDARD,
      model,
    };
  },
};
