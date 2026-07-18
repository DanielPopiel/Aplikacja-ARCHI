import sharp from "sharp";
import type { EditArea } from "./types";
import type { ImageDims } from "./upscale";
import { fetchImageBytes } from "./image-utils";
import { persistImage } from "./storage";
import { ASPECT_RATIOS } from "./providers/flux-kontext";

/**
 * Crop-and-inpaint: FLUX Fill degrades badly when the mask is a small or
 * thin sliver of a large photo — confirmed failure mode: a wide skirting
 * strip mask produced garbled pseudo-labels and a fake logo INSIDE the
 * masked band, even with a clean, negation-free prompt (the genre prior for
 * "thin band across an interior photo" is measurement annotations). The
 * standard remedy is to crop a padded region around the mask, inpaint the
 * crop (where the mask now occupies a large share of the canvas), and paste
 * the result back into the original — the model sees the edit area at a
 * much larger relative scale and stops treating it like a diagram strip.
 */

export interface CropRect {
  left: number;
  top: number;
  width: number;
  height: number;
}

/** Context kept around the marked areas, as a fraction of the canvas. */
const CONTEXT_PAD = 0.08;
/** The crop covers at least this fraction of each dimension. */
const MIN_FRAC = 0.45;
/** Above this share of the full image, cropping isn't worth the extra work. */
const MAX_CROP_AREA = 0.8;

function expandRange(lo: number, hi: number, minLen: number): [number, number] {
  if (hi - lo >= minLen) return [lo, hi];
  const extra = (minLen - (hi - lo)) / 2;
  lo -= extra;
  hi += extra;
  if (lo < 0) {
    hi = Math.min(1, hi - lo);
    lo = 0;
  }
  if (hi > 1) {
    lo = Math.max(0, lo - (hi - 1));
    hi = 1;
  }
  return [lo, hi];
}

/**
 * Pixel rect (padded + expanded union of the marked areas), or null when the
 * areas already span most of the image and cropping would gain nothing.
 */
export function computeCropRect(areas: EditArea[], dims: ImageDims): CropRect | null {
  if (areas.length === 0) return null;

  const x0 = Math.max(0, Math.min(...areas.map((a) => a.x)) - CONTEXT_PAD);
  const y0 = Math.max(0, Math.min(...areas.map((a) => a.y)) - CONTEXT_PAD);
  const x1 = Math.min(1, Math.max(...areas.map((a) => a.x + a.w)) + CONTEXT_PAD);
  const y1 = Math.min(1, Math.max(...areas.map((a) => a.y + a.h)) + CONTEXT_PAD);
  if (x1 <= x0 || y1 <= y0) return null;

  let [ex0, ex1] = expandRange(x0, x1, MIN_FRAC);
  let [ey0, ey1] = expandRange(y0, y1, MIN_FRAC);

  // Snap the crop to the closest FLUX aspect-ratio preset by GROWING one
  // dimension (never shrinking — that could cut into the marked areas).
  // Kontext renders onto a preset-shaped canvas; if the crop matches that
  // shape exactly, the resize-back-and-paste is distortion-free.
  const pxAspect = ((ex1 - ex0) * dims.width) / ((ey1 - ey0) * dims.height);
  const preset = ASPECT_RATIOS.reduce((best, cur) =>
    Math.abs(Math.log(cur.ratio / pxAspect)) < Math.abs(Math.log(best.ratio / pxAspect))
      ? cur
      : best,
  );
  if (preset.ratio > pxAspect) {
    const targetW = Math.min(1, (preset.ratio * (ey1 - ey0) * dims.height) / dims.width);
    [ex0, ex1] = expandRange(ex0, ex1, targetW);
  } else if (preset.ratio < pxAspect) {
    const targetH = Math.min(1, ((ex1 - ex0) * dims.width) / (preset.ratio * dims.height));
    [ey0, ey1] = expandRange(ey0, ey1, targetH);
  }

  if ((ex1 - ex0) * (ey1 - ey0) >= MAX_CROP_AREA) return null;

  const left = Math.round(ex0 * dims.width);
  const top = Math.round(ey0 * dims.height);
  const width = Math.min(dims.width - left, Math.round((ex1 - ex0) * dims.width));
  const height = Math.min(dims.height - top, Math.round((ey1 - ey0) * dims.height));
  if (width < 64 || height < 64) return null;

  return { left, top, width, height };
}

/** Crop the source image to the rect and persist it; returns the crop URL. */
export async function cropImage(imageUrl: string, rect: CropRect): Promise<string> {
  const { buffer } = await fetchImageBytes(imageUrl);
  const crop = await sharp(buffer).extract(rect).jpeg({ quality: 95 }).toBuffer();
  return persistImage(crop, "image/jpeg");
}

/** Paste an edited crop back into the original image at its rect. */
export async function pasteRegion(
  originalUrl: string,
  regionBuffer: Buffer,
  rect: CropRect,
): Promise<Buffer> {
  const { buffer } = await fetchImageBytes(originalUrl);
  const region = await sharp(regionBuffer)
    .resize(rect.width, rect.height, { fit: "fill" })
    .toBuffer();
  return sharp(buffer)
    .composite([{ input: region, left: rect.left, top: rect.top }])
    .jpeg({ quality: 93 })
    .toBuffer();
}
