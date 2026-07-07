import type { GenerateEditParams, GenerateEditResult, ImageEditProvider } from "./types";

// Model endpoints on fal.ai, overridable via env.
const MODEL_STANDARD = process.env.FAL_MODEL_STANDARD ?? "fal-ai/flux-pro/kontext";
const MODEL_HIGH = process.env.FAL_MODEL_HIGH ?? process.env.FAL_MODEL ?? "fal-ai/flux-pro/kontext/max";
const MODEL_FILL = process.env.FAL_MODEL_FILL ?? "fal-ai/flux-pro/v1/fill";

// Per-image costs shown in the cost counter (USD).
const COST_STANDARD = Number(process.env.FLUX_STANDARD_COST_USD ?? "0.04");
const COST_HIGH = Number(process.env.FLUX_COST_USD ?? "0.08");
const COST_FILL = Number(process.env.FLUX_FILL_COST_USD ?? "0.05");

interface FalImage {
  url: string;
  content_type?: string;
}

interface FalRunResponse {
  images?: FalImage[];
  detail?: unknown;
}

async function callFal(model: string, input: Record<string, unknown>): Promise<FalImage> {
  const apiKey = process.env.FAL_KEY;
  if (!apiKey) {
    throw new Error("Brak klucza FAL_KEY w zmiennych środowiskowych.");
  }

  const res = await fetch(`https://fal.run/${model}`, {
    method: "POST",
    headers: {
      Authorization: `Key ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(input),
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`fal.ai (${model}) zwrócił błąd ${res.status}: ${body.slice(0, 500)}`);
  }

  const data = (await res.json()) as FalRunResponse;
  const image = data.images?.[0];
  if (!image?.url) {
    throw new Error(`fal.ai nie zwrócił obrazu: ${JSON.stringify(data).slice(0, 500)}`);
  }
  return image;
}

/**
 * FLUX via fal.ai:
 * - edits without mask → FLUX.1 Kontext (pro for drafts, max for final quality),
 * - edits with a marked area → FLUX.1 Fill (true inpainting: only the mask changes).
 */
export const fluxKontextProvider: ImageEditProvider = {
  name: "flux",
  supportsMask: true,

  async generateEdit({ imageUrl, prompt, quality, maskUrl }: GenerateEditParams): Promise<GenerateEditResult> {
    if (maskUrl) {
      const image = await callFal(MODEL_FILL, {
        prompt,
        image_url: imageUrl,
        mask_url: maskUrl,
        output_format: "jpeg",
        safety_tolerance: "2",
      });
      return {
        imageUrl: image.url,
        mimeType: image.content_type ?? "image/jpeg",
        costUsd: COST_FILL,
        model: MODEL_FILL,
      };
    }

    const model = quality === "high" ? MODEL_HIGH : MODEL_STANDARD;
    const image = await callFal(model, {
      prompt,
      image_url: imageUrl,
      output_format: "jpeg",
      safety_tolerance: "2",
    });
    return {
      imageUrl: image.url,
      mimeType: image.content_type ?? "image/jpeg",
      costUsd: quality === "high" ? COST_HIGH : COST_STANDARD,
      model,
    };
  },
};
