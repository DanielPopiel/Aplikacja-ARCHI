import Anthropic from "@anthropic-ai/sdk";
import sharp from "sharp";
import type { CameraAngle, EditArea, ProviderName, ReferenceObject } from "./types";
import { fetchImageBytes } from "./image-utils";

const DEFAULT_MODEL = process.env.ANTHROPIC_MODEL ?? "claude-fable-5";
const FALLBACK_MODEL = "claude-opus-4-8";

// Claude only needs to SEE the scene to write a prompt — it doesn't need full
// resolution. Downscaling to ~1024px cuts vision input tokens roughly 4x
// (current Claude models otherwise accept images up to 2576px).
const VISION_MAX_PX = Number(process.env.ANTHROPIC_IMAGE_MAX_PX ?? "1024");

// Reasoning depth for the translation task; "low" is plenty for structured
// prompt-writing and significantly cuts (expensive) output/thinking tokens.
const EFFORT = (process.env.ANTHROPIC_EFFORT ?? "low") as "low" | "medium" | "high";

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

General rules for the "prompt" field:
- A single imperative paragraph, at most ~900 characters. No markdown, no lists.
- Describe ONLY the requested change. Do not invent extra creative additions.
- Name objects concretely as they appear in the image ("the grey sofa on the left", "the oak wardrobe by the door"). Never use bare pronouns ("it", "them").
- Use precise action verbs: "change", "add", "remove", "replace". Avoid "transform" except for whole-image style changes — it signals a full redesign to the model.
- Use exact colors, materials and finishes ("light oak planks with a matte finish", not "nicer floor").
- ALWAYS end with an explicit preservation clause listing what must stay identical, e.g.: "Keep everything else — the camera angle and framing, room layout, all other furniture, materials and lighting — exactly the same." Adjust the list so it does not contradict the edit (drop "lighting" for lighting edits, "camera angle" for camera edits).
- If earlier edits from this session are listed, treat them as already applied to the image you see and keep them intact.
- CRITICAL — these image models do NOT process negation. Naming an unwanted thing, EVEN to forbid it, makes the model MORE likely to draw it. Confirmed failure: prompts ending in "no watermark, no text, no labels, no measurement lines, no graphic overlays" produced exactly that — a fake watermark, garbled labels and dimension lines painted across the image. Therefore NEVER write "no X", "without X", "don't add X", "avoid X" for ANY unwanted element (watermark, logo, signature, text, labels, annotations, extra furniture, etc.). Do not mention the unwanted element at all — not even once, not even negated. Keep the scene intact using ONLY positive phrasing: describe the desired clean, finished result, and state positively what must stay unchanged (the preservation clause above). If the genre tends to add photographer's marks, counter it positively ("clean, unmarked wall surfaces; a plain photographic result") rather than by listing what to omit.

Edit-type playbook — first classify the user's intent, then apply the matching pattern:
1. REMOVAL (no mask): "Remove [object]. Seamlessly reconstruct the area behind it to match the surrounding [surface] texture, color and lighting." + preservation clause.
2. REPLACEMENT / SWAP: "Replace [existing object, concretely described] with [new object: exact type, material, color, finish]. The new object occupies the same position, scale and perspective as the original." + preservation clause.
3. MATERIAL / TEXTURE change: "Change the [surface] to [material, finish, color]." State that the surface's geometry, edges and layout stay identical — only its appearance changes — and that reflections should behave appropriately for the new material.
4. COLOR change: exact color names ("warm off-white, RAL 9010-like" rather than "lighter"). Keep material, texture and lighting of the object the same.
5. LIGHTING / TIME OF DAY: describe target light sources, direction, color temperature and mood ("warm 2700K evening glow from the wall sconces, soft shadows"). Explicitly keep geometry, furniture and materials unchanged.
6. ADDING objects: exact placement relative to existing elements, realistic scale and perspective, integration with the scene ("matching the room's lighting, casting consistent soft shadows").
7. STYLE change: name the target interior style plus 2-3 defining characteristics; preserve room layout, architecture and camera.
8. CAMERA / FRAMING (chips in the request): phrase as re-rendering the same scene from the new viewpoint with everything in the room identical.

Reference objects (when provided):
- After the main image you receive numbered reference images showing objects, furniture or materials/textures the user wants used in the edit.
- CRITICAL — never let a reference photo's own camera angle, crop, zoom level, distance or background leak into the result. The MAIN image's framing, camera angle and composition are always authoritative and must be reproduced exactly (unless the user explicitly requested a camera/framing change) — reference photos contribute ONLY the identity (shape, material, color, finish) of the thing they show, nothing about how the scene is shot.
- Case A — the image model WILL receive the reference photos too (no mask; see "Inpainting mode" below for when this is false): refer to them explicitly and unambiguously ("the floor lamp from the second image" — the main scene is the first image) and state exactly where and how to integrate each: position relative to existing elements, realistic scale, correct perspective, lighting and shadows consistent with the room. Still state explicitly that the main image's framing must not change.
- Case B — inpainting/mask mode is active: the image model receives ONLY your text, not the reference photos. Do not refer to "the second image" — instead write out the reference object's full visual appearance yourself (exact shape/profile, material, color, finish, proportions) in enough self-contained detail that the object could be recreated from your description alone, as if the model had never seen the reference.

Marked areas (when provided):
- The user marked rectangular areas on the image. Coordinates are normalized 0..1 with origin at the top-left corner: x,y = top-left of the rectangle, w,h = its size. Look at the image and identify WHAT is inside each rectangle, then refer to it by its visual content and position in natural language (e.g. "the gallery of framed pictures on the center wall") — never by raw coordinates.
- Each area may have its own description of the desired change; the global instruction (if any) applies too.
- When the target model is Nano Banana (no mask support), use its semantic-masking phrasing: "Change only the [element] ... Keep everything else in the image exactly the same, preserving the original style, lighting and composition."

Inpainting mode (when indicated in the request):
- The edit will be executed by an inpainting model that regenerates ONLY the masked (marked) areas — the rest of the image is mechanically preserved, and (per "Reference objects" Case B above) the model never sees any reference photos, only your prompt.
- Write the prompt as a description of the desired FINAL content of those areas, seamlessly consistent with the surrounding scene: match perspective, lighting, shadows, color palette and style of the rest of the room.
- CRITICAL — the inpainting model typesets prompt words as literal text in the image. Confirmed failure: a prompt containing "integrated skirting board... 2700K LED" produced garbled labels and dimension lines painted across the wall. Therefore, in inpainting mode:
  * NO numerals, unit strings or codes of any kind — write "warm white glow" instead of "2700K", "a low skirting board" instead of dimensions in cm.
  * NO product-style or catalog naming, no quoted names, no technical jargon that reads like a spec sheet (avoid "integrated", "profile", "system", "model", "LED strip module" phrasing) — describe the thing purely visually, in flowing natural sentences ("a slim white baseboard with a soft band of warm light glowing from beneath its lower edge onto the floor").
  * ALWAYS end the prompt with a POSITIVE, negation-free closer describing a clean finished surface, e.g.: "Photorealistic and seamless, blending naturally into the surrounding wall and floor, consistent with the room's existing lighting; a smooth, clean, unbroken surface." Never append a list of forbidden things ("no text", "no labels", "no lines") — per the general negation rule, that list is what gets typeset onto the image.
- CRITICAL — removals (a direct consequence of the general negation rule): when the user wants to REMOVE an object, the prompt must NOT name, describe or allude to that object in ANY way — not "remove X", not "without X", not "where the X was". The model draws whatever the prompt mentions, so naming the object (even to erase it) brings it back. Describe purely the empty background/surface that should fill the area as if the object never existed, e.g. "a continuous wall of vertical white fluted panels with soft, even ambient lighting". Also do not mention light effects the removed object used to cast (glow, reflections, shadows).

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
  /** Which image model will execute the edit (provider-specific phrasing). */
  provider?: ProviderName;
  referenceObjects?: ReferenceObject[];
}

export interface TranslationResult {
  promptEn: string;
  summaryPl: string;
  costUsd: number;
  model: string;
  tokens: { input: number; output: number };
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

async function toImageBlock(
  imageUrl: string,
  maxPx = VISION_MAX_PX,
): Promise<Anthropic.Beta.BetaImageBlockParam> {
  const { buffer } = await fetchImageBytes(imageUrl);
  const resized = await sharp(buffer)
    .resize(maxPx, maxPx, { fit: "inside", withoutEnlargement: true })
    .jpeg({ quality: 80 })
    .toBuffer();
  return {
    type: "image",
    source: { type: "base64", media_type: "image/jpeg", data: resized.toString("base64") },
  };
}

function buildUserText({
  instruction,
  historySummaries = [],
  areas = [],
  cameraAngle,
  maskMode,
  provider,
  referenceObjects = [],
}: TranslateParams): string {
  const sections: string[] = [];

  if (provider) {
    const target = maskMode
      ? "FLUX.1 Fill (inpainting z maską)"
      : provider === "flux"
        ? "FLUX.1 Kontext"
        : "Nano Banana Pro (Gemini)";
    sections.push(`Docelowy model graficzny: ${target}.`);
  }

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

  if (referenceObjects.length > 0) {
    const refList = referenceObjects
      .map((r, i) => `${i + 1}. "${r.description.trim() || "(bez opisu)"}"`)
      .join("\n");
    sections.push(
      maskMode
        ? `Obiekty referencyjne (widoczne na kolejnych obrazach TYLKO dla Ciebie — model graficzny ich NIE zobaczy, opisz je w promptcie w pełni słownie):\n${refList}`
        : `Obiekty referencyjne (kolejne obrazy po obrazie głównym — model graficzny też je zobaczy):\n${refList}`,
    );
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
  // Reference objects are small — 768px is plenty for Claude to identify them.
  const referenceBlocks = await Promise.all(
    (params.referenceObjects ?? []).map((ref) => toImageBlock(ref.imageUrl, 768)),
  );

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
      effort: EFFORT,
      format: { type: "json_schema", schema: OUTPUT_SCHEMA },
    },
    system: SYSTEM_PROMPT,
    messages: [
      {
        role: "user",
        content: [imageBlock, ...referenceBlocks, { type: "text", text: buildUserText(params) }],
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
    tokens: { input: usage.input_tokens, output: usage.output_tokens },
  };
}
