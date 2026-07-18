import type { GenerateEditParams, GenerateEditResult, ImageEditProvider } from "./types";
import { callFal } from "./flux-kontext";

/**
 * Instruction-following edit models on fal.ai that take image_urls + a prompt
 * and (unlike FLUX Fill) never need a mask. For masked edits the route hands
 * them a CROP of the marked region and composites the result back, so these
 * work as regional editors exactly like Kontext does. They also accept the
 * main image + reference photos natively as image_urls (maskless refs), like
 * Gemini. Output dimensions are normalized to the input downstream, so no
 * per-model size math is needed here beyond a resolution hint for cost.
 */

// --- Seedream 5.0 Lite Edit: cheap + fast, ideal for the "test" tier and
//     model comparisons (dramatically reduced hallucination per ByteDance). ---
const SEEDREAM_MODEL = process.env.FAL_MODEL_SEEDREAM ?? "fal-ai/bytedance/seedream/v5/lite/edit";
const SEEDREAM_COST = Number(process.env.SEEDREAM_COST_USD ?? "0.035");

export const seedreamProvider: ImageEditProvider = {
  name: "seedream",
  supportsMask: false,

  async generateEdit({
    imageUrl,
    prompt,
    quality,
    referenceImageUrls = [],
  }: GenerateEditParams): Promise<GenerateEditResult> {
    const image = await callFal(SEEDREAM_MODEL, {
      prompt,
      image_urls: [imageUrl, ...referenceImageUrls],
      image_size: quality === "high" ? "auto_4K" : "auto_2K",
    });
    return {
      imageUrl: image.url,
      mimeType: image.content_type ?? "image/jpeg",
      costUsd: SEEDREAM_COST,
      model: SEEDREAM_MODEL,
    };
  },
};

// --- Nano Banana 2 Edit (Google, via fal): strong spatial understanding and
//     coherent local repainting — the quality pick for interiors. ---
const NB2_MODEL = process.env.FAL_MODEL_NANO2 ?? "fal-ai/nano-banana-2/edit";
const NB2_COST_STANDARD = Number(process.env.NANO2_COST_USD ?? "0.08");
const NB2_COST_HIGH = Number(process.env.NANO2_HIGH_COST_USD ?? "0.16");

export const nanoBanana2Provider: ImageEditProvider = {
  name: "nano-banana-2",
  supportsMask: false,

  async generateEdit({
    imageUrl,
    prompt,
    quality,
    referenceImageUrls = [],
  }: GenerateEditParams): Promise<GenerateEditResult> {
    const image = await callFal(NB2_MODEL, {
      prompt,
      image_urls: [imageUrl, ...referenceImageUrls],
      resolution: quality === "high" ? "2K" : "1K",
      output_format: "jpeg",
    });
    return {
      imageUrl: image.url,
      mimeType: image.content_type ?? "image/jpeg",
      costUsd: quality === "high" ? NB2_COST_HIGH : NB2_COST_STANDARD,
      model: NB2_MODEL,
    };
  },
};
