import sharp from "sharp";
import { callFal } from "./providers/flux-kontext";
import { fetchImageBytes } from "./image-utils";

// AuraSR: fal's fast, faithful 4x GAN upscaler — good for renders (keeps
// geometry straight, no hallucinated detail). Override via env if needed.
const MODEL_UPSCALE = process.env.FAL_MODEL_UPSCALE ?? "fal-ai/aura-sr";
const UPSCALE_COST_USD = Number(process.env.UPSCALE_COST_USD ?? "0.02");

export interface ImageDims {
  width: number;
  height: number;
}

export async function readImageDims(url: string): Promise<ImageDims | null> {
  try {
    const { buffer } = await fetchImageBytes(url);
    const meta = await sharp(buffer).metadata();
    if (!meta.width || !meta.height) return null;
    return { width: meta.width, height: meta.height };
  } catch {
    return null;
  }
}

export interface NormalizedResult {
  buffer: Buffer;
  mimeType: string;
  extraCostUsd: number;
}

/**
 * Final-quality tier: bring the generated result to the SAME pixel
 * dimensions as the image that was edited, so quality never degrades along
 * the edit chain. Image models output ~1MP; when the result is smaller than
 * the input it goes through fal.ai's AuraSR (4x) first, then is snapped to
 * the input's exact size (or its short side, if the generator deliberately
 * changed the aspect ratio, e.g. for camera-angle edits).
 */
export async function normalizeToInputSize(opts: {
  /** Result URL (fal) — enables AuraSR upscaling. */
  imageUrl?: string;
  /** Result bytes (Gemini base64) when no URL exists. */
  buffer?: Buffer;
  mimeType: string;
  input: ImageDims;
}): Promise<NormalizedResult> {
  let buffer = opts.buffer ?? (await fetchImageBytes(opts.imageUrl!)).buffer;
  let mimeType = opts.mimeType;
  let extraCostUsd = 0;

  let meta = await sharp(buffer).metadata();
  const inputShort = Math.min(opts.input.width, opts.input.height);
  let outShort = Math.min(meta.width ?? 0, meta.height ?? 0);

  // Clearly smaller than the input and fal can read it → one AuraSR pass.
  if (outShort > 0 && outShort < inputShort * 0.95 && opts.imageUrl) {
    const upscaled = await callFal(MODEL_UPSCALE, { image_url: opts.imageUrl });
    const bytes = await fetchImageBytes(upscaled.url);
    buffer = bytes.buffer;
    mimeType = bytes.mimeType;
    extraCostUsd = UPSCALE_COST_USD;
    meta = await sharp(buffer).metadata();
    outShort = Math.min(meta.width ?? 0, meta.height ?? 0);
  }

  const outW = meta.width ?? 0;
  const outH = meta.height ?? 0;
  if (!outW || !outH || (outW === opts.input.width && outH === opts.input.height)) {
    return { buffer, mimeType, extraCostUsd };
  }

  const aspectIn = opts.input.width / opts.input.height;
  const aspectOut = outW / outH;
  const aspectDiff = Math.abs(aspectOut - aspectIn) / aspectIn;

  let resized: Buffer;
  if (aspectDiff <= 0.03) {
    // Same framing — snap to the exact original dimensions.
    resized = await sharp(buffer)
      .resize(opts.input.width, opts.input.height, { fit: "fill" })
      .jpeg({ quality: 93 })
      .toBuffer();
  } else {
    // The generator changed the aspect ratio (e.g. a camera/framing edit) —
    // match the original short side without distorting the new composition.
    const isLandscape = outW >= outH;
    resized = await sharp(buffer)
      .resize(isLandscape ? undefined : inputShort, isLandscape ? inputShort : undefined)
      .jpeg({ quality: 93 })
      .toBuffer();
  }
  return { buffer: resized, mimeType: "image/jpeg", extraCostUsd };
}
