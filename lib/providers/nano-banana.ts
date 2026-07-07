import type { GenerateEditParams, GenerateEditResult, ImageEditProvider } from "./types";
import { fetchImageAsBase64 } from "../image-utils";

const GEMINI_MODEL = process.env.GEMINI_IMAGE_MODEL ?? "gemini-3-pro-image-preview";
const GEMINI_COST_USD = Number(process.env.GEMINI_COST_USD ?? "0.139");

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

/**
 * Nano Banana Pro (Gemini 3 Pro Image) via Google AI Studio REST API.
 * No native mask support — marked areas are handled in the prompt
 * (Claude describes them spatially). Quality maps to output resolution.
 */
export const nanoBananaProvider: ImageEditProvider = {
  name: "gemini",
  supportsMask: false,

  async generateEdit({ imageUrl, prompt, quality }: GenerateEditParams): Promise<GenerateEditResult> {
    const apiKey = process.env.GOOGLE_API_KEY;
    if (!apiKey) {
      throw new Error("Brak klucza GOOGLE_API_KEY w zmiennych środowiskowych.");
    }

    const source = await fetchImageAsBase64(imageUrl);

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
              parts: [
                { inlineData: { mimeType: source.mimeType, data: source.base64 } },
                { text: prompt },
              ],
            },
          ],
          generationConfig: {
            responseModalities: ["TEXT", "IMAGE"],
            imageConfig: { imageSize: quality === "high" ? "2K" : "1K" },
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
      costUsd: GEMINI_COST_USD,
      model: GEMINI_MODEL,
    };
  },
};
