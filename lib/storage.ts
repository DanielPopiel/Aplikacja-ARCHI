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
    // Copy into a guaranteed non-shared Buffer before handing it to
    // @vercel/blob (which uploads via undici's fetch). sharp's `.toBuffer()`
    // can, on some runtimes (observed on Vercel/Linux, not on Windows dev),
    // return a Buffer backed by a SharedArrayBuffer — and Node's web APIs
    // reject those with "ArrayBuffer: SharedArrayBuffer is not allowed",
    // which surfaced as a total edit failure. Buffer.from(buffer) copies the
    // bytes into a normal ArrayBuffer, matching the known-good upload path.
    const safe = Buffer.from(buffer);
    const blob = await put(`archi/${crypto.randomUUID()}.${extFor(mimeType)}`, safe, {
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
