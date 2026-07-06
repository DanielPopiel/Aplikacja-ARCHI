export interface ImageBytes {
  buffer: Buffer;
  mimeType: string;
}

/** Fetch an http(s) or data: URL into raw bytes. */
export async function fetchImageBytes(url: string): Promise<ImageBytes> {
  if (url.startsWith("data:")) {
    const match = url.match(/^data:([^;,]+)?(;base64)?,(.*)$/);
    if (!match) throw new Error("Nieprawidłowy data URL obrazu.");
    const mimeType = match[1] || "application/octet-stream";
    const data = match[2]
      ? Buffer.from(match[3], "base64")
      : Buffer.from(decodeURIComponent(match[3]), "utf8");
    return { buffer: data, mimeType };
  }

  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`Nie udało się pobrać obrazu (${res.status}): ${url.slice(0, 200)}`);
  }
  const mimeType = res.headers.get("content-type")?.split(";")[0] || "image/jpeg";
  return { buffer: Buffer.from(await res.arrayBuffer()), mimeType };
}

export async function fetchImageAsBase64(url: string): Promise<{ base64: string; mimeType: string }> {
  const { buffer, mimeType } = await fetchImageBytes(url);
  return { base64: buffer.toString("base64"), mimeType };
}
