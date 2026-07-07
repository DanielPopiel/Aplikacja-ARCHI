import Anthropic from "@anthropic-ai/sdk";
import type { CameraAngle, EditArea } from "./types";
import { fetchImageAsBase64 } from "./image-utils";

const DEFAULT_MODEL = process.env.ANTHROPIC_MODEL ?? "claude-fable-5";
const FALLBACK_MODEL = "claude-opus-4-8";

/** Models the UI may request — anything else falls back to the default. */
export const ALLOWED_CLAUDE_MODELS = [
  "claude-fable-5",
  "claude-opus-4-8",
  "claude-sonnet-5",
] as const;

// USD per 1M tokens, keyed by model-id prefix (response.model may be the
// fallback model when the primary declined the request).
const PRICING: Array<{ prefix: string; input: number; output: number }> = [
  { prefix: "claude-fable-5", input: 10, output: 50 },
  { prefix: "claude-mythos", input: 10, output: 50 },
  { prefix: "claude-opus", input: 5, output: 25 },
  { prefix: "claude-sonnet", input: 3, output: 15 },
  { prefix: "claude-haiku", input: 1, output: 5 },
];

const CAMERA_ANGLE_EN: Record<CameraAngle, string> = {
  low: "re-render the scene from a low camera angle (camera close to the floor, looking slightly up)",
  high: "re-render the scene from a high camera angle (camera above eye level, looking down)",
  left: "re-render the scene with the camera moved to the left side of the room",
  right: "re-render the scene with the camera moved to the right side of the room",
  detail: "zoom in for a close-up detail shot of the main subject of the edit",
  wide: "re-render as a wide-angle shot showing more of the room",
};

const SYSTEM_PROMPT = `You are the instruction-translation layer of a personal interior-design editing app.

The user uploads a photo or render of an interior and types editing instructions in Polish (occasionally English). You can see the current state of the image. Your job is to turn each instruction into a precise, structured English editing prompt optimized for context-aware image editing models (FLUX.1 Kontext, FLUX.1 Fill inpainting, Nano Banana Pro / Gemini image editing).

Rules for the "prompt" field:
- Describe ONLY the requested change. Do not invent extra creative additions.
- Explicitly state what must remain unchanged when it matters: camera angle, room layout, composition, other furniture, window views, overall lighting (unless the change is about lighting or camera).
- Refer to objects concretely, as they appear in the image (e.g. "the grey sofa on the left", "the wooden floor").
- Be specific about materials, colors, finishes and lighting quality (e.g. "light oak wood planks with a matte finish" instead of "nicer floor").
- Write a single imperative instruction, at most ~900 characters. No markdown, no lists.
- If earlier edits from this session are listed, treat them as already applied to the image you see and keep them intact.

Marked areas (when provided):
- The user marked rectangular areas on the image. Coordinates are normalized 0..1 with origin at the top-left corner: x,y = top-left of the rectangle, w,h = its size. Look at the image and identify WHAT is inside each rectangle, then refer to it by its visual content and position in natural language (e.g. "the gallery of framed pictures on the center wall") — never by raw coordinates.
- Each area may have its own description of the desired change; the global instruction (if any) applies too.

Inpainting mode (when indicated in the request):
- The edit will be executed by an inpainting model that regenerates ONLY the masked (marked) areas — the rest of the image is mechanically preserved.
- Write the prompt as a description of the desired FINAL content of those areas, seamlessly consistent with the surrounding scene: match perspective, lighting, shadows, color palette and style of the rest of the room.

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

export interface TranslateParams {
  imageUrl: string;
  instruction: string;
  historySummaries?: string[];
  areas?: EditArea[];
  cameraAngle?: CameraAngle | null;
  /** Claude model requested by the UI; validated against ALLOWED_CLAUDE_MODELS. */
  model?: string;
  /** True when a mask-based inpainting model will execute the edit. */
  maskMode?: boolean;
}

export interface TranslationResult {
  promptEn: string;
  summaryPl: string;
  costUsd: number;
  model: string;
}

function priceFor(model: string): { input: number; output: number } {
  return PRICING.find((p) => model.startsWith(p.prefix)) ?? PRICING[0];
}

function resolveModel(requested?: string): string {
  if (requested && (ALLOWED_CLAUDE_MODELS as readonly string[]).includes(requested)) {
    return requested;
  }
  return DEFAULT_MODEL;
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

function buildUserText({
  instruction,
  historySummaries = [],
  areas = [],
  cameraAngle,
  maskMode,
}: TranslateParams): string {
  const sections: string[] = [];

  sections.push(
    instruction.trim()
      ? `Polecenie użytkownika: "${instruction.trim()}"`
      : "Polecenie użytkownika: (brak globalnego polecenia — zmiany opisane per obszar poniżej)",
  );

  if (areas.length > 0) {
    const list = areas
      .map(
        (a, i) =>
          `${i + 1}. rect(x=${a.x.toFixed(3)}, y=${a.y.toFixed(3)}, w=${a.w.toFixed(3)}, h=${a.h.toFixed(3)}) — "${a.description.trim() || "(bez opisu — zastosuj polecenie globalne)"}"`,
      )
      .join("\n");
    sections.push(`Zaznaczone obszary na obrazie:\n${list}`);
    sections.push(
      maskMode
        ? "Tryb: INPAINTING — model wygeneruje od nowa wyłącznie zaznaczone obszary."
        : "Tryb: bez maski — w promptcie wyraźnie ogranicz zmiany do zawartości zaznaczonych obszarów i każ zachować całą resztę bez zmian.",
    );
  }

  if (cameraAngle) {
    sections.push(`Dodatkowo zmiana kadru: ${CAMERA_ANGLE_EN[cameraAngle]}.`);
  }

  if (historySummaries.length > 0) {
    sections.push(
      `Earlier edits in this session (already applied to the image):\n${historySummaries
        .map((s, i) => `${i + 1}. ${s}`)
        .join("\n")}`,
    );
  }

  return sections.join("\n\n");
}

export async function translateInstruction(params: TranslateParams): Promise<TranslationResult> {
  if (!process.env.ANTHROPIC_API_KEY) {
    throw new Error("Brak klucza ANTHROPIC_API_KEY w zmiennych środowiskowych.");
  }

  const client = new Anthropic();
  const model = resolveModel(params.model);
  const imageBlock = await toImageBlock(params.imageUrl);

  const response = await client.beta.messages.create({
    model,
    max_tokens: 8000,
    // Server-side fallback: if Fable 5's safety classifiers decline a benign
    // request, the same call is transparently re-served by Opus 4.8.
    ...(model === "claude-fable-5"
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
        content: [imageBlock, { type: "text", text: buildUserText(params) }],
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
