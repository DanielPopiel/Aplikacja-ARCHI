import { put } from "@vercel/blob";
import { fetchImageBytes } from "./image-utils";

function extFor(mimeType: string): string {
  if (mimeType.includes("png")) return "png";
  if (mimeType.includes("webp")) return "webp";
  return "jpg";
}

/**
 * Persist image bytes and return a durable URL.
 * With BLOB_READ_WRITE_TOKEN set (Vercel Blob) → public blob URL.
 * Without it (bare local dev) → data: URL fallback so the pipeline still works.
 */
export async function persistImage(buffer: Buffer, mimeType: string): Promise<string> {
  if (process.env.BLOB_READ_WRITE_TOKEN) {
    const blob = await put(`archi/${crypto.randomUUID()}.${extFor(mimeType)}`, buffer, {
      access: "public",
      contentType: mimeType,
    });
    return blob.url;
  }
  return `data:${mimeType};base64,${buffer.toString("base64")}`;
}

/** Copy an external image (e.g. a temporary fal.ai CDN URL) into our storage. */
export async function persistImageFromUrl(url: string): Promise<string> {
  const { buffer, mimeType } = await fetchImageBytes(url);
  return persistImage(buffer, mimeType);
}
