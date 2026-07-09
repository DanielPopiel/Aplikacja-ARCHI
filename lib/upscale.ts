import sharp from "sharp";
import { callFal } from "./providers/flux-kontext";
import { fetchImageBytes } from "./image-utils";

// AuraSR: fal's fast, faithful 4x GAN upscaler — good for renders (keeps
// geometry straight, no hallucinated detail). Override via env if needed.
const MODEL_UPSCALE = process.env.FAL_MODEL_UPSCALE ?? "fal-ai/aura-sr";
const UPSCALE_COST_USD = Number(process.env.UPSCALE_COST_USD ?? "0.02");

/** Final-quality target: short side of the output image (px). */
export const TARGET_SHORT_SIDE = Number(process.env.OUTPUT_SHORT_SIDE_PX ?? "2160");

export interface HighResResult {
  buffer: Buffer;
  mimeType: string;
  extraCostUsd: number;
  upscaled: boolean;
}

/**
 * Ensure the final image has a short side of at least TARGET_SHORT_SIDE.
 * Image models output ~1MP; for the "high" quality tier we upscale via
 * fal.ai, then normalize down to exactly the target (keeps files sane).
 */
export async function ensureHighRes(imageUrl: string): Promise<HighResResult> {
  const original = await fetchImageBytes(imageUrl);
  const meta = await sharp(original.buffer).metadata();
  const shortSide = Math.min(meta.width ?? 0, meta.height ?? 0);

  // Already at target (e.g. Gemini 4K output) — pass through untouched.
  if (shortSide >= TARGET_SHORT_SIDE * 0.95) {
    return { buffer: original.buffer, mimeType: original.mimeType, extraCostUsd: 0, upscaled: false };
  }

  const upscaledImage = await callFal(MODEL_UPSCALE, { image_url: imageUrl });
  const upscaledBytes = await fetchImageBytes(upscaledImage.url);
  const upMeta = await sharp(upscaledBytes.buffer).metadata();
  const upShort = Math.min(upMeta.width ?? 0, upMeta.height ?? 0);

  // Normalize: 4x upscale of ~1MP can exceed 4K — bring short side to target.
  if (upShort > TARGET_SHORT_SIDE) {
    const isLandscape = (upMeta.width ?? 0) >= (upMeta.height ?? 0);
    const resized = await sharp(upscaledBytes.buffer)
      .resize(
        isLandscape ? undefined : TARGET_SHORT_SIDE,
        isLandscape ? TARGET_SHORT_SIDE : undefined,
      )
      .jpeg({ quality: 93 })
      .toBuffer();
    return { buffer: resized, mimeType: "image/jpeg", extraCostUsd: UPSCALE_COST_USD, upscaled: true };
  }

  return {
    buffer: upscaledBytes.buffer,
    mimeType: upscaledBytes.mimeType,
    extraCostUsd: UPSCALE_COST_USD,
    upscaled: true,
  };
}
