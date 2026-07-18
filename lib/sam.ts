import sharp from "sharp";
import type { EditArea } from "./types";
import type { ImageDims } from "./upscale";
import { callFalJson } from "./providers/flux-kontext";
import { fetchImageBytes } from "./image-utils";
import { persistImage } from "./storage";

const SAM_MODEL = process.env.FAL_MODEL_SAM ?? "fal-ai/sam-3/image";
export const SAM_COST_USD = Number(process.env.SAM_COST_USD ?? "0.005");

interface SamMask {
  url: string;
}
interface SamResponse {
  masks?: SamMask[];
}

/**
 * Turn the user's rough rectangles into a pixel-accurate object mask using
 * SAM 3: each rectangle becomes a box prompt, SAM returns the segmented
 * object inside it, and we union those into one white-on-black mask at the
 * image's exact size. This replaces the crude "whole rectangle" mask so an
 * edit only touches the actual object (baseboard, door, lamp), not the
 * surrounding wall/floor the rectangle happened to include.
 *
 * Returns a persisted mask URL, or null on any failure — the caller falls
 * back to the client-built rectangle mask, so SAM is a pure quality upgrade
 * that can never block an edit.
 */
export async function refineMaskWithSam(
  imageUrl: string,
  areas: EditArea[],
  dims: ImageDims,
): Promise<string | null> {
  if (areas.length === 0) return null;
  try {
    const { width: W, height: H } = dims;
    const box_prompts = areas.map((a, i) => ({
      x_min: Math.max(0, Math.round(a.x * W)),
      y_min: Math.max(0, Math.round(a.y * H)),
      x_max: Math.min(W, Math.round((a.x + a.w) * W)),
      y_max: Math.min(H, Math.round((a.y + a.h) * H)),
      object_id: i + 1,
    }));

    const data = await callFalJson<SamResponse>(SAM_MODEL, {
      image_url: imageUrl,
      box_prompts,
      apply_mask: false,
      output_format: "png",
    });

    const maskUrls = (data.masks ?? []).map((m) => m.url).filter(Boolean);
    if (maskUrls.length === 0) return null;

    // Union all per-object masks (grayscale max) into one full-size mask.
    const maskBuffers = await Promise.all(
      maskUrls.map(async (url) => {
        const { buffer } = await fetchImageBytes(url);
        return sharp(buffer).resize(W, H, { fit: "fill" }).grayscale().raw().toBuffer();
      }),
    );

    const union = Buffer.alloc(W * H);
    for (const mb of maskBuffers) {
      for (let i = 0; i < union.length; i++) {
        if (mb[i] > union[i]) union[i] = mb[i];
      }
    }

    // Binarize, then dilate slightly (blur + threshold) so the mask has a
    // little tolerance around the object edge for replacements whose new
    // silhouette differs a touch from the original.
    const mask = await sharp(union, { raw: { width: W, height: H, channels: 1 } })
      .threshold(110)
      .blur(6)
      .threshold(40)
      .png()
      .toBuffer();

    // Reject empty/near-empty masks (SAM found nothing) — fall back instead.
    const stats = await sharp(mask).stats();
    const meanWhite = stats.channels[0]?.mean ?? 0;
    if (meanWhite < 1) return null;

    return await persistImage(mask, "image/png");
  } catch (err) {
    console.error("SAM mask refinement failed, using rectangle mask:", err);
    return null;
  }
}
