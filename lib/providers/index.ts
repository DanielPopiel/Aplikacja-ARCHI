import type { ProviderName } from "../types";
import type { ImageEditProvider } from "./types";
import { fluxKontextProvider } from "./flux-kontext";
import { nanoBananaProvider } from "./nano-banana";

const providers: Record<ProviderName, ImageEditProvider> = {
  flux: fluxKontextProvider,
  gemini: nanoBananaProvider,
};

/**
 * Provider selection: explicit request value wins, otherwise the
 * IMAGE_PROVIDER env flag (default: flux).
 */
export function getProvider(requested?: ProviderName): ImageEditProvider {
  const name = requested ?? (process.env.IMAGE_PROVIDER as ProviderName | undefined) ?? "flux";
  const provider = providers[name];
  if (!provider) {
    throw new Error(`Nieznany dostawca obrazów: ${name}`);
  }
  return provider;
}
