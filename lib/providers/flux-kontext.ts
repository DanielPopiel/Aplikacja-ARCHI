import sharp from "sharp";
import type { GenerateEditParams, GenerateEditResult, ImageEditProvider } from "./types";
import { fetchImageBytes } from "../image-utils";

// Model endpoints on fal.ai, overridable via env.
const MODEL_STANDARD = process.env.FAL_MODEL_STANDARD ?? "fal-ai/flux-pro/kontext";
const MODEL_HIGH = process.env.FAL_MODEL_HIGH ?? process.env.FAL_MODEL ?? "fal-ai/flux-pro/kontext/max";
const MODEL_FILL = process.env.FAL_MODEL_FILL ?? "fal-ai/flux-pro/v1/fill";
const MODEL_MULTI = process.env.FAL_MODEL_MULTI ?? "fal-ai/flux-pro/kontext/max/multi";

// Per-image costs shown in the cost counter (USD).
const COST_STANDARD = Number(process.env.FLUX_STANDARD_COST_USD ?? "0.04");
const COST_HIGH = Number(process.env.FLUX_COST_USD ?? "0.08");
const COST_FILL = Number(process.env.FLUX_FILL_COST_USD ?? "0.05");
const COST_MULTI = Number(process.env.FLUX_MULTI_COST_USD ?? "0.08");

interface FalImage {
  url: string;
  content_type?: string;
}

interface FalRunResponse {
  images?: FalImage[];
  image?: FalImage;
  detail?: unknown;
}

export async function callFal(model: string, input: Record<string, unknown>): Promise<FalImage> {
  const apiKey = process.env.FAL_KEY;
  if (!apiKey) {
    throw new Error("Brak klucza FAL_KEY w zmiennych środowiskowych.");
  }

  const res = await fetch(`https://fal.run/${model}`, {
    method: "POST",
    headers: {
      Authorization: `Key ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(input),
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`fal.ai (${model}) zwrócił błąd ${res.status}: ${body.slice(0, 500)}`);
  }

  const data = (await res.json()) as FalRunResponse;
  const image = data.images?.[0] ?? data.image;
  if (!image?.url) {
    throw new Error(`fal.ai nie zwrócił obrazu: ${JSON.stringify(data).slice(0, 500)}`);
  }
  return image;
}

const ASPECT_RATIOS: Array<{ value: string; ratio: number }> = [
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
 * - edits with a marked area → FLUX.1 Fill (true inpainting: only the mask changes),
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
      // Fill works directly on the given image + mask, so it already
      // preserves the input's own dimensions — no aspect_ratio needed.
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
