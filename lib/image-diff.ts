import sharp from "sharp";
import { fetchImageBytes } from "./image-utils";

/**
 * Mean absolute grayscale difference between the source image and the edit
 * result, both downscaled to a common small size. Cheap no-op detector:
 * editors sometimes decide the request already matches the image (confirmed
 * failure: "replace the white glowing baseboard with a white glowing
 * baseboard") and return a near-identical picture — the user still pays and
 * has to squint to notice nothing happened. Values are 0..1; JPEG
 * re-encoding noise alone stays well under NO_CHANGE_THRESHOLD, a real
 * regional edit lands clearly above it (calibrated in tests).
 */
export const NO_CHANGE_THRESHOLD = 0.004;

export async function meanAbsDiff(originalUrl: string, editedBuffer: Buffer): Promise<number> {
  const SIZE = 256;
  const [a, b] = await Promise.all([
    fetchImageBytes(originalUrl).then(({ buffer }) =>
      sharp(buffer).resize(SIZE, SIZE, { fit: "fill" }).grayscale().raw().toBuffer(),
    ),
    sharp(editedBuffer).resize(SIZE, SIZE, { fit: "fill" }).grayscale().raw().toBuffer(),
  ]);
  let sum = 0;
  for (let i = 0; i < a.length; i++) sum += Math.abs(a[i] - b[i]);
  return sum / a.length / 255;
}
