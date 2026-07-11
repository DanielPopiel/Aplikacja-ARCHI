import sharp from "sharp";
import { fetchImageBytes } from "./image-utils";

/**
 * FLUX Fill (and inpainting models generally) regenerate the WHOLE canvas
 * conditioned on the mask — they do not mechanically preserve pixels outside
 * the marked area, only approximate it. Confirmed failure: unrelated
 * background objects mutating between otherwise-identical runs, and
 * hallucinated pseudo-text/annotation squiggles appearing far outside the
 * marked baseboard zones. Fix: force the "outside mask = untouched"
 * guarantee ourselves by pasting the model's result only where the mask is
 * white, and the ORIGINAL image everywhere else.
 *
 * Mask convention matches lib/client/mask.ts: white = regenerate, black =
 * keep. The mask is blurred slightly before use so the paste seam blends
 * into the padding band that was already added around each marked rect.
 */
export async function compositeOutsideMask(opts: {
  editedBuffer: Buffer;
  originalUrl: string;
  maskUrl: string;
  width: number;
  height: number;
}): Promise<Buffer> {
  const { width: W, height: H } = opts;
  const [original, mask] = await Promise.all([
    fetchImageBytes(opts.originalUrl),
    fetchImageBytes(opts.maskUrl),
  ]);

  const [origRaw, editedRaw, maskRaw] = await Promise.all([
    sharp(original.buffer).resize(W, H, { fit: "fill" }).ensureAlpha().raw().toBuffer(),
    sharp(opts.editedBuffer).resize(W, H, { fit: "fill" }).ensureAlpha().raw().toBuffer(),
    sharp(mask.buffer).resize(W, H, { fit: "fill" }).grayscale().blur(4).raw().toBuffer(),
  ]);

  const out = Buffer.alloc(W * H * 4);
  for (let i = 0; i < W * H; i++) {
    const m = maskRaw[i] / 255; // 0 = keep original, 1 = use edited result
    const p = i * 4;
    out[p] = Math.round(origRaw[p] * (1 - m) + editedRaw[p] * m);
    out[p + 1] = Math.round(origRaw[p + 1] * (1 - m) + editedRaw[p + 1] * m);
    out[p + 2] = Math.round(origRaw[p + 2] * (1 - m) + editedRaw[p + 2] * m);
    out[p + 3] = 255;
  }

  return sharp(out, { raw: { width: W, height: H, channels: 4 } })
    .jpeg({ quality: 93 })
    .toBuffer();
}
