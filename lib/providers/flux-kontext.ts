import sharp from "sharp";
import type { GenerateEditParams, GenerateEditResult, ImageEditProvider } from "./types";
import { fetchImageBytes } from "../image-utils";

// Model endpoints on fal.ai, overridable via env.
const MODEL_STANDARD = process.env.FAL_MODEL_STANDARD ?? "fal-ai/flux-pro/kontext";
const MODEL_HIGH = process.env.FAL_MODEL_HIGH ?? process.env.FAL_MODEL ?? "fal-ai/flux-pro/kontext/max";
const MODEL_MULTI = process.env.FAL_MODEL_MULTI ?? "fal-ai/flux-pro/kontext/max/multi";
const MODEL_ERASER = process.env.FAL_MODEL_ERASER ?? "fal-ai/bria/eraser";

// Per-image costs shown in the cost counter (USD).
const COST_STANDARD = Number(process.env.FLUX_STANDARD_COST_USD ?? "0.04");
const COST_HIGH = Number(process.env.FLUX_COST_USD ?? "0.08");
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

/** Raw fal.run call with retry — returns the full parsed JSON body. */
export async function callFalJson<T = unknown>(
  model: string,
  input: Record<string, unknown>,
): Promise<T> {
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

    if (res.ok) return (await res.json()) as T;

    const body = await res.text();
    lastError = `fal.ai (${model}) zwrócił błąd ${res.status}: ${body.slice(0, 500)}`;
    if (!RETRYABLE_STATUS.has(res.status)) break;
  }
  throw new Error(lastError);
}

/** fal.run call that expects an image result (images[0] or image). */
export async function callFal(model: string, input: Record<string, unknown>): Promise<FalImage> {
  const data = await callFalJson<FalRunResponse>(model, input);
  const image = data.images?.[0] ?? data.image;
  if (!image?.url) {
    throw new Error(`fal.ai nie zwrócił obrazu: ${JSON.stringify(data).slice(0, 500)}`);
  }
  return image;
}

/**
 * Bria Eraser — prompt-less background reconstruction inside the mask. Used
 * for pure removals regardless of which editor model the user picked, since
 * a dedicated eraser can't redraw the object or typeset prompt words the way
 * a generative model does. Provider-independent (it's just a fal model).
 */
export async function eraseMasked(
  imageUrl: string,
  maskUrl: string,
): Promise<GenerateEditResult> {
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
 * FLUX via fal.ai (the instruction-following EDITOR used for non-removal
 * edits). Masked edits arrive here already CROPPED to the marked region by
 * the route — the crop's mask boundary is enforced afterwards by the
 * server-side pixel composite, so Kontext just edits the image it's given.
 * - reference objects present → Kontext Max Multi (main image + references),
 * - otherwise → Kontext (pro for drafts, max for final quality).
 * Removals never reach here — the route sends them to the shared Bria eraser.
 */
export const fluxKontextProvider: ImageEditProvider = {
  name: "flux",
  supportsMask: true,

  async generateEdit({
    imageUrl,
    prompt,
    quality,
    referenceImageUrls,
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
