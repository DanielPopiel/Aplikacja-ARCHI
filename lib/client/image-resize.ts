"use client";

/**
 * Downscale an image client-side before upload:
 * - keeps requests under Vercel's 4.5 MB body limit,
 * - image models don't benefit from >2K inputs anyway.
 */
export async function prepareImageForUpload(file: File, maxDim = 2048): Promise<Blob> {
  const bitmap = await createImageBitmap(file);
  const { width, height } = bitmap;

  const scale = Math.min(1, maxDim / Math.max(width, height));
  // Small file that already fits — send as-is.
  if (scale === 1 && file.size < 3_500_000) {
    bitmap.close();
    return file;
  }

  const canvas = document.createElement("canvas");
  canvas.width = Math.round(width * scale);
  canvas.height = Math.round(height * scale);
  const ctx = canvas.getContext("2d");
  if (!ctx) {
    bitmap.close();
    return file;
  }
  ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  bitmap.close();

  const blob = await new Promise<Blob | null>((resolve) =>
    canvas.toBlob(resolve, "image/jpeg", 0.92),
  );
  return blob ?? file;
}
