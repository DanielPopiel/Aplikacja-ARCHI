import type { GenerateEditParams, GenerateEditResult, ImageEditProvider } from "./types";

const FAL_MODEL = process.env.FAL_MODEL ?? "fal-ai/flux-pro/kontext/max";
const FLUX_COST_USD = Number(process.env.FLUX_COST_USD ?? "0.08");

interface FalImage {
  url: string;
  content_type?: string;
}

interface FalRunResponse {
  images?: FalImage[];
  detail?: unknown;
}

/**
 * FLUX.1 Kontext [Max] via fal.ai synchronous endpoint (https://fal.run).
 * Accepts public URLs and data: URIs as image_url.
 */
export const fluxKontextProvider: ImageEditProvider = {
  name: "flux",

  async generateEdit({ imageUrl, prompt }: GenerateEditParams): Promise<GenerateEditResult> {
    const apiKey = process.env.FAL_KEY;
    if (!apiKey) {
      throw new Error("Brak klucza FAL_KEY w zmiennych środowiskowych.");
    }

    const res = await fetch(`https://fal.run/${FAL_MODEL}`, {
      method: "POST",
      headers: {
        Authorization: `Key ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        prompt,
        image_url: imageUrl,
        output_format: "jpeg",
        safety_tolerance: "2",
      }),
    });

    if (!res.ok) {
      const body = await res.text();
      throw new Error(`fal.ai (${FAL_MODEL}) zwrócił błąd ${res.status}: ${body.slice(0, 500)}`);
    }

    const data = (await res.json()) as FalRunResponse;
    const image = data.images?.[0];
    if (!image?.url) {
      throw new Error(`fal.ai nie zwrócił obrazu: ${JSON.stringify(data).slice(0, 500)}`);
    }

    return {
      imageUrl: image.url,
      mimeType: image.content_type ?? "image/jpeg",
      costUsd: FLUX_COST_USD,
    };
  },
};
