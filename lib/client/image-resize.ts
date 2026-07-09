"use client";

/**
 * Prepare an image for upload preserving final-product quality:
 * - keeps the short side up to 2160 px (4K-class) and long side up to 4096 px,
 * - re-encodes stepping quality down only as far as needed to fit under
 *   Vercel's 4.5 MB request body limit.
 */
export async function prepareImageForUpload(
  file: File,
  maxShortSide = 2160,
  maxLongSide = 4096,
): Promise<Blob> {
  const SIZE_LIMIT = 4_200_000;
  const bitmap = await createImageBitmap(file);
  const shortSide = Math.min(bitmap.width, bitmap.height);
  const longSide = Math.max(bitmap.width, bitmap.height);

  const scale = Math.min(1, maxShortSide / shortSide, maxLongSide / longSide);
  if (scale === 1 && file.size < SIZE_LIMIT) {
    bitmap.close();
    return file;
  }

  const canvas = document.createElement("canvas");
  canvas.width = Math.round(bitmap.width * scale);
  canvas.height = Math.round(bitmap.height * scale);
  const ctx = canvas.getContext("2d");
  if (!ctx) {
    bitmap.close();
    return file;
  }
  ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  bitmap.close();

  let best: Blob | null = null;
  for (const quality of [0.93, 0.88, 0.82, 0.75]) {
    best = await new Promise<Blob | null>((resolve) =>
      canvas.toBlob(resolve, "image/jpeg", quality),
    );
    if (best && best.size < SIZE_LIMIT) return best;
  }
  return best ?? file;
}

/** Smaller variant for reference-object images (detail matters, size less). */
export async function prepareReferenceForUpload(file: File): Promise<Blob> {
  return prepareImageForUpload(file, 1024, 1600);
}
