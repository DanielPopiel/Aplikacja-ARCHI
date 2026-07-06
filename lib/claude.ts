import Anthropic from "@anthropic-ai/sdk";
import { fetchImageAsBase64 } from "./image-utils";

const MODEL = process.env.ANTHROPIC_MODEL ?? "claude-fable-5";
const FALLBACK_MODEL = "claude-opus-4-8";

// USD per 1M tokens, keyed by model-id prefix (response.model may be the
// fallback model when the primary declined the request).
const PRICING: Array<{ prefix: string; input: number; output: number }> = [
  { prefix: "claude-fable-5", input: 10, output: 50 },
  { prefix: "claude-mythos", input: 10, output: 50 },
  { prefix: "claude-opus", input: 5, output: 25 },
  { prefix: "claude-sonnet", input: 3, output: 15 },
  { prefix: "claude-haiku", input: 1, output: 5 },
];

const SYSTEM_PROMPT = `You are the instruction-translation layer of a personal interior-design editing app.

The user uploads a photo or render of an interior and types editing instructions in Polish (occasionally English). You can see the current state of the image. Your job is to turn each instruction into a precise, structured English editing prompt optimized for context-aware image editing models (FLUX.1 Kontext, Nano Banana Pro / Gemini image editing).

Rules for the "prompt" field:
- Describe ONLY the requested change. Do not invent extra creative additions.
- Explicitly state what must remain unchanged when it matters: camera angle, room layout, composition, other furniture, window views, overall lighting (unless the change is about lighting).
- Refer to objects concretely, as they appear in the image (e.g. "the grey sofa on the left", "the wooden floor").
- Be specific about materials, colors, finishes and lighting quality (e.g. "light oak wood planks with a matte finish" instead of "nicer floor").
- Write a single imperative instruction, at most ~900 characters. No markdown, no lists.
- If earlier edits from this session are listed, treat them as already applied to the image you see and keep them intact.

Rules for the "summary" field:
- One short sentence in Polish, past tense, describing what was changed in this iteration (shown in the app's history), e.g. "Zmieniono podłogę na jasny dąb i rozjaśniono wnętrze."`;

const OUTPUT_SCHEMA = {
  type: "object",
  properties: {
    prompt: {
      type: "string",
      description: "English editing prompt for the image model",
    },
    summary: {
      type: "string",
      description: "One-sentence Polish summary of the change",
    },
  },
  required: ["prompt", "summary"],
  additionalProperties: false,
} as const;

export interface TranslationResult {
  promptEn: string;
  summaryPl: string;
  costUsd: number;
  model: string;
}

function priceFor(model: string): { input: number; output: number } {
  return PRICING.find((p) => model.startsWith(p.prefix)) ?? PRICING[0];
}

type Base64MediaType = "image/jpeg" | "image/png" | "image/gif" | "image/webp";
const BASE64_MEDIA_TYPES: readonly Base64MediaType[] = [
  "image/jpeg",
  "image/png",
  "image/gif",
  "image/webp",
];

async function toImageBlock(imageUrl: string): Promise<Anthropic.Beta.BetaImageBlockParam> {
  if (!imageUrl.startsWith("data:")) {
    return { type: "image", source: { type: "url", url: imageUrl } };
  }
  const { base64, mimeType } = await fetchImageAsBase64(imageUrl);
  const media =
    BASE64_MEDIA_TYPES.find((m) => m === mimeType) ?? ("image/jpeg" as const);
  return {
    type: "image",
    source: { type: "base64", media_type: media, data: base64 },
  };
}

export async function translateInstruction(
  imageUrl: string,
  instruction: string,
  historySummaries: string[] = [],
): Promise<TranslationResult> {
  if (!process.env.ANTHROPIC_API_KEY) {
    throw new Error("Brak klucza ANTHROPIC_API_KEY w zmiennych środowiskowych.");
  }

  const client = new Anthropic();

  const historyText =
    historySummaries.length > 0
      ? `\n\nEarlier edits in this session (already applied to the image):\n${historySummaries
          .map((s, i) => `${i + 1}. ${s}`)
          .join("\n")}`
      : "";

  const imageBlock = await toImageBlock(imageUrl);

  const response = await client.beta.messages.create({
    model: MODEL,
    max_tokens: 8000,
    // Server-side fallback: if Fable 5's safety classifiers decline a benign
    // request, the same call is transparently re-served by Opus 4.8.
    ...(MODEL === "claude-fable-5"
      ? {
          betas: ["server-side-fallback-2026-06-01"],
          fallbacks: [{ model: FALLBACK_MODEL }],
        }
      : {}),
    output_config: {
      effort: "medium",
      format: { type: "json_schema", schema: OUTPUT_SCHEMA },
    },
    system: SYSTEM_PROMPT,
    messages: [
      {
        role: "user",
        content: [
          imageBlock,
          {
            type: "text",
            text: `Polecenie użytkownika: "${instruction}"${historyText}`,
          },
        ],
      },
    ],
  });

  if (response.stop_reason === "refusal") {
    throw new Error(
      "Model odmówił przetworzenia tego polecenia (safety refusal). Spróbuj przeformułować.",
    );
  }

  const textBlock = response.content.find((b) => b.type === "text");
  if (!textBlock || textBlock.type !== "text") {
    throw new Error("Claude nie zwrócił treści tekstowej.");
  }

  let parsed: { prompt: string; summary: string };
  try {
    parsed = JSON.parse(textBlock.text);
  } catch {
    throw new Error(`Nie udało się sparsować odpowiedzi Claude: ${textBlock.text.slice(0, 300)}`);
  }

  const price = priceFor(response.model);
  const usage = response.usage;
  const costUsd =
    (usage.input_tokens / 1_000_000) * price.input +
    (usage.output_tokens / 1_000_000) * price.output;

  return {
    promptEn: parsed.prompt,
    summaryPl: parsed.summary,
    costUsd,
    model: response.model,
  };
}
