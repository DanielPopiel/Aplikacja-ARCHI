import type { ProviderName, Quality } from "../types";

export interface GenerateEditParams {
  /** Public URL or data: URL of the source image */
  imageUrl: string;
  /** English editing prompt (already optimized by the Claude layer) */
  prompt: string;
  /** Draft vs final quality — providers map this to a model/resolution. */
  quality: Quality;
  /** Optional inpainting mask (white = regenerate, black = keep). */
  maskUrl?: string;
}

export interface GenerateEditResult {
  /** Exactly one of imageUrl / imageBase64 is set */
  imageUrl?: string;
  imageBase64?: string;
  mimeType: string;
  costUsd: number;
  /** Which concrete model/endpoint handled the edit (for history/debug). */
  model: string;
}

export interface ImageEditProvider {
  name: ProviderName;
  /** True if the provider applies maskUrl natively (inpainting). */
  supportsMask: boolean;
  generateEdit(params: GenerateEditParams): Promise<GenerateEditResult>;
}
