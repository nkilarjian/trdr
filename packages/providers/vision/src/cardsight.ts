// CardSight AI — real trading-card recognition (photo → identified cards, GRADED
// and RAW). Used by /api/v1/identify when CARDSIGHT_API_KEY is set; the general
// vision read is the fallback when it isn't. Endpoint, field name ("image"), and
// auth header confirmed from CardSight's Node SDK source.

import type { IdentifiedCard, ImageInput } from "./index.js";

const ENDPOINT = "https://api.cardsight.ai/v1/identify/card";
// CardSight returns a confidence BAND; map to our 0..1 (the trade UI gates at 0.6).
const CONF: Record<string, number> = { High: 0.92, Medium: 0.66, Low: 0.45 };

interface CSCard {
  year?: string;
  manufacturer?: string;
  releaseName?: string;
  setName?: string;
  name?: string;
  number?: string;
  parallel?: { name?: string };
}
interface CSDetection {
  confidence?: string;
  card?: CSCard;
  grading?: { company?: { name?: string }; grade?: { value?: string } };
}

// One search-ready name per card, so the trade flow can value it (graded) or link
// eBay-sold (raw), exactly like a type-in. Grade appended only for slabbed cards.
function nameOf(d: CSDetection): string {
  const c = d.card ?? {};
  const parts = [c.year, c.manufacturer, c.releaseName, c.name, c.number ? `#${c.number}` : "", c.parallel?.name].filter(
    (x): x is string => typeof x === "string" && x.trim().length > 0,
  );
  let name = parts.join(" ").replace(/\s+/g, " ").trim();
  if (d.grading?.company?.name && d.grading?.grade?.value) name = `${name} ${d.grading.company.name} ${d.grading.grade.value}`.trim();
  return name;
}

function stripDataUrl(b?: string): string | undefined {
  if (!b) return undefined;
  if (b.startsWith("data:")) {
    const m = b.match(/^data:(.*?);base64,(.*)$/s);
    return m ? m[2] : undefined;
  }
  return b;
}

export async function identifyWithCardSight(image: ImageInput, apiKey: string): Promise<IdentifiedCard[]> {
  const data = stripDataUrl(image.base64);
  if (!data) throw new Error("CardSight: image base64 required");
  const form = new FormData();
  const bytes = new Uint8Array(Buffer.from(data, "base64"));
  form.append("image", new Blob([bytes], { type: image.mediaType ?? "image/jpeg" }), "card.jpg");
  const res = await fetch(ENDPOINT, { method: "POST", headers: { "X-API-Key": apiKey }, body: form });
  if (!res.ok) throw new Error(`CardSight ${res.status}: ${await res.text()}`);
  const body = (await res.json()) as { detections?: CSDetection[] };
  return (body.detections ?? [])
    .map((d) => ({ name: nameOf(d), graded: !!d.grading, confidence: CONF[d.confidence ?? "Low"] ?? 0.45 }))
    .filter((c) => c.name.length > 0);
}
