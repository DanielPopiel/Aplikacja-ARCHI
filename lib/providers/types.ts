import type { ProviderName } from "../types";

export interface GenerateEditParams {
  /** Public URL or data: URL of the source image */
  imageUrl: string;
  /** English editing prompt (already optimized by the Claude layer) */
  prompt: string;
}

export interface GenerateEditResult {
  /** Exactly one of imageUrl / imageBase64 is set */
  imageUrl?: string;
  imageBase64?: string;
  mimeType: string;
  costUsd: number;
}

export interface ImageEditProvider {
  name: ProviderName;
  generateEdit(params: GenerateEditParams): Promise<GenerateEditResult>;
}
