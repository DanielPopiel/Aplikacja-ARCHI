import sharp from "sharp";
import type { GenerateEditParams, GenerateEditResult, ImageEditProvider } from "./types";
import { fetchImageBytes } from "../image-utils";

const GEMINI_MODEL = process.env.GEMINI_IMAGE_MODEL ?? "gemini-3-pro-image-preview";
const GEMINI_COST_USD = Number(process.env.GEMINI_COST_USD ?? "0.139");
const GEMINI_4K_COST_USD = Number(process.env.GEMINI_4K_COST_USD ?? "0.24");

interface GeminiPart {
  text?: string;
  inlineData?: { mimeType: string; data: string };
}

interface GeminiResponse {
  candidates?: Array<{
    content?: { parts?: GeminiPart[] };
    finishReason?: string;
  }>;
  promptFeedback?: unknown;
}

/** Inline payloads must stay small — downscale inputs before base64-encoding. */
async function toInlinePart(imageUrl: string, maxPx: number): Promise<GeminiPart> {
  const { buffer } = await fetchImageBytes(imageUrl);
  const resized = await sharp(buffer)
    .resize(maxPx, maxPx, { fit: "inside", withoutEnlargement: true })
    .jpeg({ quality: 90 })
    .toBuffer();
  return { inlineData: { mimeType: "image/jpeg", data: resized.toString("base64") } };
}

/**
 * Nano Banana Pro (Gemini 3 Pro Image) via Google AI Studio REST API.
 * No native mask support — marked areas are handled in the prompt.
 * Reference objects go in natively as additional input images.
 * Quality maps to output resolution: standard → 1K, high → 4K (short side ~2160px).
 */
export const nanoBananaProvider: ImageEditProvider = {
  name: "gemini",
  supportsMask: false,

  async generateEdit({
    imageUrl,
    prompt,
    quality,
    referenceImageUrls = [],
  }: GenerateEditParams): Promise<GenerateEditResult> {
    const apiKey = process.env.GOOGLE_API_KEY;
    if (!apiKey) {
      throw new Error("Brak klucza GOOGLE_API_KEY w zmiennych środowiskowych.");
    }

    const mainPart = await toInlinePart(imageUrl, 2048);
    const referenceParts = await Promise.all(
      referenceImageUrls.map((url) => toInlinePart(url, 1024)),
    );

    const res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`,
      {
        method: "POST",
        headers: {
          "x-goog-api-key": apiKey,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          contents: [
            {
              parts: [mainPart, ...referenceParts, { text: prompt }],
            },
          ],
          generationConfig: {
            responseModalities: ["TEXT", "IMAGE"],
            imageConfig: { imageSize: quality === "high" ? "4K" : "1K" },
          },
        }),
      },
    );

    if (!res.ok) {
      const body = await res.text();
      throw new Error(`Google AI (${GEMINI_MODEL}) zwrócił błąd ${res.status}: ${body.slice(0, 500)}`);
    }

    const data = (await res.json()) as GeminiResponse;
    const parts = data.candidates?.[0]?.content?.parts ?? [];
    const imagePart = parts.find((p) => p.inlineData?.data);

    if (!imagePart?.inlineData) {
      const finishReason = data.candidates?.[0]?.finishReason;
      throw new Error(
        `Google AI nie zwrócił obrazu (finishReason: ${finishReason ?? "brak"}).`,
      );
    }

    return {
      imageBase64: imagePart.inlineData.data,
      mimeType: imagePart.inlineData.mimeType || "image/png",
      costUsd: quality === "high" ? GEMINI_4K_COST_USD : GEMINI_COST_USD,
      model: GEMINI_MODEL,
    };
  },
};
