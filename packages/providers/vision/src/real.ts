// Real VisionProvider. Default backend is Claude's vision API: given a photo of
// graded slabs, the model reads each slab's grader + cert number + an approximate
// box and a confidence. The bulk-intake pipeline then resolves those certs via
// the GradingProvider. Swap in an on-device detector (Apple Vision / ML Kit) or a
// hosted model behind the same interface later.

import type { Grader } from "@trdr/core";
import type { DetectedSlab, ImageInput, VisionProvider } from "./index.js";

export interface RealVisionConfig {
  /** "claude" (default) — or "apple-vision" | "mlkit" | a custom endpoint. */
  backend?: string;
  anthropicApiKey?: string;
  model?: string;
  endpointUrl?: string;
  apiKey?: string;
}

const PROMPT = [
  "This is a photo of one or more GRADED trading-card slabs (PSA, CGC, SGC, or BGS).",
  "Read each slab's PRINTED LABEL carefully and transcribe EXACTLY what is printed. Do NOT infer, autocomplete, or correct from memory. If any character is covered by glare or too blurry to read, OMIT that field and lower your confidence rather than guessing.",
  "For every slab you can see, return:",
  '- grader: one of "PSA" | "CGC" | "SGC" | "BGS"',
  "- cert: the printed certification / serial number (digits), or omit if unreadable",
  '- set: the descriptive line as printed — year, brand/set and player/subject, e.g. "2018 Panini Prizm Luka Doncic" (omit if unreadable)',
  '- number: the card number, e.g. "280" (digits/letters as printed; omit the # sign)',
  '- variant: the parallel/insert/variety ONLY if it is actually printed on the label, e.g. "Silver", "Refractor". A plain base card has NO variant — leave it out rather than assuming one.',
  "- grade: the numeric grade as a number, e.g. 10, 9.5 (omit if unreadable)",
  "- confidence: 0..1 — your honest certainty of the WHOLE read; use a low value if any field was hard to make out",
  "- boundingBox: {x,y,w,h} as fractions 0..1 of the image",
  'Respond with ONLY a JSON array, e.g. [{"grader":"PSA","cert":"58127634","set":"2018 Panini Prizm Luka Doncic","number":"280","variant":"Silver","grade":10,"confidence":0.95,"boundingBox":{"x":0.1,"y":0.1,"w":0.2,"h":0.3}}].',
  "Include glare/blurred slabs too, with low confidence and whatever fields you can read. No prose, JSON only.",
].join("\n");

interface RawSlab {
  grader?: string;
  cert?: string;
  set?: string;
  number?: string | number;
  variant?: string;
  grade?: number | string;
  confidence?: number;
  boundingBox?: { x: number; y: number; w: number; h: number };
}

export class RealVisionProvider implements VisionProvider {
  constructor(readonly config: RealVisionConfig) {}

  async detectSlabs(image: ImageInput): Promise<DetectedSlab[]> {
    const backend = (this.config.backend ?? "claude").toLowerCase();
    if (backend !== "claude") {
      // TODO(vision): on-device (Apple Vision / ML Kit) or a custom endpointUrl.
      throw new Error(`RealVisionProvider: backend "${backend}" not implemented — use "claude" or wire a detector`);
    }
    if (!this.config.anthropicApiKey) throw new Error("RealVisionProvider: ANTHROPIC_API_KEY required for the claude backend");

    const { data, mediaType } = normalize(image);
    if (!data) throw new Error("RealVisionProvider: image base64 required (the web upload sends it)");

    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "x-api-key": this.config.anthropicApiKey,
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        // Identifying a card off a photo is error-prone OCR + reasoning, so default
        // to the most capable VISION model with adaptive thinking ON — it reasons
        // about ambiguous/glared labels before answering instead of one-shotting,
        // which cuts misidentifications. Slower + pricier than Haiku; override with
        // VISION_MODEL (e.g. claude-haiku-4-5-20251001) when speed matters more.
        model: this.config.model ?? "claude-opus-4-8",
        max_tokens: 8192,
        // Adaptive thinking (Opus 4.8): the model decides how much to reason; do
        // NOT use budget_tokens here (rejected with 400 on 4.8). effort "high"
        // trades latency for accuracy — the point of this mode.
        thinking: { type: "adaptive" },
        output_config: { effort: "high" },
        messages: [
          {
            role: "user",
            content: [
              { type: "image", source: { type: "base64", media_type: mediaType, data } },
              { type: "text", text: PROMPT },
            ],
          },
        ],
      }),
    });
    if (!res.ok) throw new Error(`Anthropic vision API ${res.status}: ${await res.text()}`);

    const body = (await res.json()) as { content?: { type: string; text?: string }[] };
    const text = body.content?.find((b) => b.type === "text")?.text ?? "[]";
    return parseSlabs(text).map((s, i) => ({
      id: `v${i}`,
      grader: normalizeGrader(s.grader),
      certGuess: s.cert,
      card: toCard(s),
      confidence: clamp01(typeof s.confidence === "number" ? s.confidence : 0.5),
      boundingBox: s.boundingBox,
    }));
  }
}

function normalize(image: ImageInput): { data?: string; mediaType: string } {
  let data = image.base64;
  let mediaType = image.mediaType ?? "image/jpeg";
  if (data && data.startsWith("data:")) {
    const m = data.match(/^data:(.*?);base64,(.*)$/s);
    if (m) {
      mediaType = m[1] || mediaType;
      data = m[2];
    }
  }
  return { data, mediaType };
}

function parseSlabs(text: string): RawSlab[] {
  const start = text.indexOf("[");
  const end = text.lastIndexOf("]");
  if (start === -1 || end === -1 || end < start) return [];
  try {
    const arr = JSON.parse(text.slice(start, end + 1));
    return Array.isArray(arr) ? (arr as RawSlab[]) : [];
  } catch {
    return [];
  }
}

function toCard(s: RawSlab): { set?: string; number?: string; variant?: string; grade?: number } | undefined {
  const set = typeof s.set === "string" && s.set.trim() ? s.set.trim() : undefined;
  const number = s.number != null && String(s.number).trim() ? String(s.number).replace(/^#/, "").trim() : undefined;
  const variant = typeof s.variant === "string" && s.variant.trim() ? s.variant.trim() : undefined;
  const grade = typeof s.grade === "number" ? s.grade : typeof s.grade === "string" && s.grade.trim() ? Number(s.grade) : undefined;
  if (!set && number == null && grade == null && !variant) return undefined;
  return { set, number, variant, grade: Number.isFinite(grade) ? grade : undefined };
}

function normalizeGrader(g?: string): Grader | undefined {
  const up = (g ?? "").toUpperCase();
  return up === "PSA" || up === "CGC" || up === "SGC" || up === "BGS" ? (up as Grader) : undefined;
}
function clamp01(x: number): number {
  return Math.max(0, Math.min(1, x));
}
