// ─── Wishlist: a wish TREE the user builds by adding flat wishes ───
// The user never designs the hierarchy — they add wishes (broad or specific)
// and buildWishTree auto-organizes them: category → subject → set → card → grade.
// A background scan then surfaces listings "worth checking out" per wish, scored
// for VALUE (the mispricing engine) and COOL (serendipity: low pop, gem grade,
// sleeper auctions, rare variants).
//
// This module is intentionally dependency-free (no imports) so it can be vendored
// verbatim into the mobile app for live client-side re-grouping as the user types.

export type WishLevel = "root" | "category" | "subject" | "set" | "card" | "grade";

/** One wish the user expressed. Any field may be absent (broader = fewer fields). */
export interface WishSpec {
  id: string;
  category?: string; // "Basketball", "Pokémon"
  subject?: string; // player / character: "Luka Dončić", "Charizard"
  set?: string; // "2018 Panini Prizm"
  number?: string;
  variant?: string; // "Silver", "Holo"
  grader?: string; // "PSA" | "CGC" | ...
  minGrade?: number; // e.g. 9 ⇒ "9 or better"
  maxPrice?: number; // budget
  note?: string;
}

export interface WishNode {
  id: string;
  level: WishLevel;
  label: string;
  /** Accumulated constraints from the root down to this node. */
  spec: Partial<WishSpec>;
  children: WishNode[];
  /** Set on the deepest node of a user wish. */
  wishId?: string;
}

/** Auto-organize flat wishes into a hierarchy. The headline "set-up is simple". */
export function buildWishTree(specs: WishSpec[]): WishNode {
  const root: WishNode = { id: "root", level: "root", label: "Wishlist", spec: {}, children: [] };

  for (const spec of specs) {
    const steps: { level: WishLevel; label: string | undefined; add: Partial<WishSpec> }[] = [
      { level: "category", label: spec.category, add: { category: spec.category } },
      { level: "subject", label: spec.subject, add: { subject: spec.subject } },
      { level: "set", label: spec.set, add: { set: spec.set } },
      { level: "card", label: cardLabel(spec), add: { number: spec.number, variant: spec.variant } },
      { level: "grade", label: gradeLabel(spec), add: { grader: spec.grader, minGrade: spec.minGrade } },
    ];

    let node = root;
    let acc: Partial<WishSpec> = {};
    for (const step of steps) {
      if (!step.label) continue;
      acc = { ...acc, ...prune(step.add) };
      let child = node.children.find((c) => c.level === step.level && c.label === step.label);
      if (!child) {
        child = { id: `${node.id}/${step.level}:${step.label}`, level: step.level, label: step.label, spec: { ...acc }, children: [] };
        node.children.push(child);
      }
      node = child;
    }
    // carry budget/note onto the leaf; tag the wish
    node.spec = { ...node.spec, ...prune({ maxPrice: spec.maxPrice, note: spec.note }) };
    if (node !== root) node.wishId = spec.id;
  }

  return root;
}

/** Count the leaf wishes under a node (for compact tree summaries). */
export function countWishes(node: WishNode): number {
  if (node.wishId) return 1;
  return node.children.reduce((n, c) => n + countWishes(c), 0);
}

/** Crude natural-language → WishSpec so the app can accept free text ("luka prizm psa 10"). */
export function parseWish(text: string, id: string): WishSpec {
  const spec: WishSpec = { id };
  const grader = text.match(/\b(PSA|CGC|SGC|BGS)\b/i)?.[1];
  if (grader) spec.grader = grader.toUpperCase();
  const grade = text.match(/\b(10|9\.5|9|8\.5|8)\b/)?.[1];
  if (grade) spec.minGrade = Number(grade);

  const lower = text.toLowerCase();
  for (const [needle, category] of CATEGORY_HINTS) if (lower.includes(needle)) spec.category = category;
  for (const setName of KNOWN_SETS) if (lower.includes(setName.toLowerCase())) spec.set = setName;

  // whatever's left, with grader/grade/set words removed, becomes the subject
  const subject = text
    .replace(/\b(PSA|CGC|SGC|BGS)\b/gi, "")
    .replace(/\b(10|9\.5|9|8\.5|8)\b/g, "")
    .replace(new RegExp(KNOWN_SETS.map(escape).join("|"), "gi"), "")
    .replace(/\b(any|graded|rookie|rc)\b/gi, "")
    .replace(/\s+/g, " ")
    .trim();
  if (subject) spec.subject = titleCase(subject);
  return spec;
}

// ─── Interest scoring (value + cool) ───

export interface InterestInput {
  currentPrice: number;
  buyingOption: "AUCTION" | "BIN";
  bidCount?: number;
  hoursLeft?: number;
  /** Predicted edge after costs from the mispricing gate (>0 ⇒ underpriced). */
  expectedEdge?: number;
  fairPoint?: number;
  confidence?: number;
  /** Population at this exact grade (low ⇒ rare). */
  popAtGrade?: number;
  grade?: number;
  variant?: string;
  maxPrice?: number; // budget from the wish
}

export interface InterestScore {
  value: number; // [0,1] good-value signal
  cool: number; // [0,1] serendipity signal
  interest: number; // headline score
  tags: string[];
  worthIt: boolean;
  overBudget: boolean;
}

export function scoreInterest(input: InterestInput): InterestScore {
  const tags: string[] = [];
  const overBudget = input.maxPrice != null && input.currentPrice > input.maxPrice;

  // value: realized edge as a fraction of fair value, weighted by confidence
  let value = 0;
  if (input.expectedEdge && input.expectedEdge > 0 && input.fairPoint) {
    value = clamp01((input.expectedEdge / (input.fairPoint * 0.2)) * (input.confidence ?? 1));
    if (value >= 0.4) tags.push("good value");
  }

  // cool: rarity + grade + sleeper + variant
  const lowPop = input.popAtGrade != null ? clamp01(1 - input.popAtGrade / 500) : 0;
  if (lowPop >= 0.5) tags.push("low pop");
  // gem grade is common on modern cards — a mild nudge, not enough to flag alone
  const highGrade = (input.grade ?? 0) >= 10 ? 0.25 : (input.grade ?? 0) >= 9.5 ? 0.15 : (input.grade ?? 0) >= 9 ? 0.05 : 0;
  if ((input.grade ?? 0) >= 10) tags.push("gem grade");
  const sleeper = input.buyingOption === "AUCTION" && (input.bidCount ?? 0) <= 2 && (input.hoursLeft ?? 99) < 24 ? 0.3 : 0;
  if (sleeper > 0) tags.push("sleeper");
  const variantCool = input.variant ? 0.1 : 0;
  if (variantCool > 0) tags.push("rare variant");
  const cool = clamp01(0.6 * lowPop + highGrade + sleeper + variantCool);

  if (input.maxPrice != null && !overBudget) tags.push("under budget");
  if (overBudget) tags.push("over budget");

  const worthIt = !overBudget && (value >= 0.4 || cool >= 0.5);
  return { value, cool, interest: Math.max(value, cool), tags, worthIt, overBudget };
}

// ─── helpers ───

const CATEGORY_HINTS: [string, string][] = [
  ["basketball", "Basketball"],
  ["prizm", "Basketball"],
  ["pokemon", "Pokémon"],
  ["pokémon", "Pokémon"],
  ["charizard", "Pokémon"],
  ["football", "Football"],
  ["baseball", "Baseball"],
];
const KNOWN_SETS = ["2018 Panini Prizm Basketball", "2018 Panini Prizm", "Topps Chrome", "Base Set"];

function cardLabel(s: WishSpec): string | undefined {
  if (!s.number) return undefined;
  return `#${s.number}${s.variant ? " " + s.variant : ""}`;
}
function gradeLabel(s: WishSpec): string | undefined {
  if (s.minGrade != null) return `${s.grader ? s.grader + " " : ""}${s.minGrade}+`;
  return s.grader;
}
function prune<T extends object>(o: T): Partial<T> {
  const out: Partial<T> = {};
  for (const k in o) if (o[k] != null) out[k] = o[k];
  return out;
}
function clamp01(x: number): number {
  return Math.max(0, Math.min(1, x));
}
function escape(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
function titleCase(s: string): string {
  return s.replace(/\b\w/g, (c) => c.toUpperCase());
}
