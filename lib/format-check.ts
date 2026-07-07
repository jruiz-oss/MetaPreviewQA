// Deterministic format/size check — computed in code, not by the model.
// Extracted from app/api/qa/route.ts (FIX #17) so it is unit-testable, same
// pattern as lib/url-compare.ts. Route files can't export helpers in the App
// Router, so this is the only way to regression-test the token logic.

import type { FormatInfo } from "@/lib/meta-api";

export type ComputedCheck = { status: "pass" | "fail" | "warning" | "unknown"; note: string };

// Tokenize a name (filename or ad unit name) into lowercase alphanumeric
// tokens. Keeps short-but-meaningful tokens like "v1", "v2", "1x1", "9x16"
// (length ≥ 2) which are exactly the version/format discriminators we need.
//
// Pre-step: split camelCase boundaries (lower→Upper) before lowercasing, so a
// glued filename token like "LuckyEmber" becomes ["lucky","ember"] and matches
// an ad unit named "Lucky Ember". Without this, "luckyember" matches neither
// "lucky" nor "ember", so the unit gets zero signal from its own approved files
// and the ranker falls back to generic tokens (mis-routing the assets to
// another unit). This is purely additive: names that already contain a space or
// separator (e.g. "Oak Fork", "Caesars") are unaffected and tokenize exactly as
// before.
export function tokenize(s: string): string[] {
  return s
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length >= 2);
}

// format_size: name tokens are the primary intent signal, dimensions the
// evidence, placements the tiebreaker — same rules the prompt used to describe,
// now applied deterministically.
export function classifyDim(width: number, height: number): "story" | "feed" | "landscape" | "other" {
  const ratio = width / height;
  if (ratio >= 0.54 && ratio <= 0.58) return "story"; // 9:16
  if (ratio >= 0.78 && ratio <= 0.82) return "feed"; // 4:5
  if (ratio >= 0.98 && ratio <= 1.02) return "feed"; // 1:1
  if (ratio >= 1.88 && ratio <= 1.94) return "landscape"; // 1.91:1
  return "other";
}

// Dimension-consistency rules (computed deterministically from per-asset dims):
//  1. CAROUSEL CARDS — all cards in one carousel must share ONE exact size.
//     One 2040×1080 card among 1080×1080 siblings is a real defect → FAIL.
//  2. SAME-RATIO MIXED SIZES — two unique sizes with the SAME aspect ratio in
//     one ad (e.g. 920×920 + 1080×1080, both 1:1) can't be placement variants
//     (those differ in ratio: 1:1 vs 4:5 vs 9:16) → WARNING. Different-ratio
//     sizes are legitimate placement customization and are never flagged.
export function checkDimensionConsistency(fi: FormatInfo | null | undefined): { failNote: string | null; warnNote: string | null } {
  // Rule 1: carousel card uniformity (exact WxH, per-card, not deduped).
  let failNote: string | null = null;
  const cards = fi?.cardDimensions ?? [];
  if (cards.length >= 2) {
    const counts = new Map<string, number>();
    for (const c of cards) {
      const key = `${c.width}×${c.height}`;
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
    if (counts.size > 1) {
      const parts = Array.from(counts.entries())
        .sort((a, b) => b[1] - a[1])
        .map(([size, n]) => `${n}× ${size}`);
      failNote = `carousel cards have mixed sizes (${parts.join(", ")}) — all cards in a carousel should share one size`;
    }
  }

  // Rule 2: same aspect ratio, different pixel sizes (unique IMAGE dims only —
  // videos legitimately ship at other resolutions and are excluded).
  let warnNote: string | null = null;
  const dims = fi?.imageDimensions ?? [];
  const byRatio = new Map<string, string[]>();
  for (const d of dims) {
    const key = (d.width / d.height).toFixed(2);
    if (!byRatio.has(key)) byRatio.set(key, []);
    byRatio.get(key)!.push(`${d.width}×${d.height}`);
  }
  const mixed = Array.from(byRatio.values()).filter((sizes) => sizes.length > 1);
  if (mixed.length) {
    warnNote = `multiple sizes share the same aspect ratio within this ad (${mixed
      .map((s) => s.join(" vs "))
      .join("; ")}) — same-format assets should be one size; verify this is intentional`;
  }
  return { failNote, warnNote };
}

// Combines the placement/format expectation check with the dimension
// consistency rules above. Consistency failures dominate (fail > warning),
// and notes are merged so neither finding hides the other.
export function computeFormatSizeCheck(unitName: string, fi: FormatInfo | null | undefined): ComputedCheck {
  const base = computePlacementFormatCheck(unitName, fi);
  const { failNote, warnNote } = checkDimensionConsistency(fi);
  if (!failNote && !warnNote) return base;

  const notes: string[] = [];
  if (failNote) notes.push(failNote);
  if (warnNote) notes.push(warnNote);
  if (base.status === "fail" || (base.status === "warning" && base.note)) notes.push(base.note);

  const status: ComputedCheck["status"] =
    failNote || base.status === "fail" ? "fail" : "warning";
  return { status, note: notes.join("; ") };
}

export function computePlacementFormatCheck(unitName: string, fi: FormatInfo | null | undefined): ComputedCheck {
  const dims = fi?.creativeDimensions ?? [];
  if (!dims.length) return { status: "unknown", note: "Creative dimensions not available." };

  const kinds = dims.map((d) => classifyDim(d.width, d.height));
  const has916 = kinds.includes("story");
  const hasFeed = kinds.includes("feed");
  const sizesStr = dims.map((d) => `${d.width}×${d.height}`).join(", ");

  const tokens = new Set(tokenize(unitName));
  // Colon ratio notation ("9:16", "4:5", "1:1") tokenizes into bare numbers
  // ("9" is even dropped for being too short), so it's matched on the raw name.
  const rawName = unitName.toLowerCase();
  const expectsStory =
    tokens.has("story") || tokens.has("stories") || tokens.has("reel") || tokens.has("reels") ||
    tokens.has("9x16") || /\b9\s*:\s*16\b/.test(rawName);
  // FIX #17: "static" is NOT a feed signal. In ad naming it means still-image
  // (vs video/carousel/GIF), not feed placement — a "Story Static" or
  // "Static 9x16" unit with only a 1080x1920 asset used to hard-FAIL here
  // ("no 1:1 or 4:5 asset") even though it was a correctly-sized story static.
  // Real feed intent is already covered by feed/1x1/4x5/square/ratio tokens.
  const expectsFeed =
    tokens.has("feed") || tokens.has("1x1") || tokens.has("4x5") ||
    tokens.has("square") || /\b(1\s*:\s*1|4\s*:\s*5)\b/.test(rawName);

  const issues: string[] = [];
  if (expectsStory && !has916) {
    issues.push(`ad name indicates Story/Reel but no 9:16 asset exists (sizes: ${sizesStr}) — content will be cut off or letterboxed`);
  }
  if (expectsFeed && !hasFeed) {
    issues.push(`ad name indicates Feed (1:1/4:5) but no 1:1 or 4:5 asset exists (sizes: ${sizesStr}) — will appear cropped in feed`);
  }
  if (issues.length) return { status: "fail", note: issues.join("; ") };
  if (expectsStory || expectsFeed) {
    return { status: "pass", note: `Asset sizes (${sizesStr}) match the format indicated by the ad name.` };
  }

  // No format signal in the name — judge by placements.
  if (fi?.placements?.automatic) {
    if (has916 && hasFeed) {
      return { status: "pass", note: `Advantage+ automatic placements with both feed and story sizes (${sizesStr}).` };
    }
    return {
      status: "warning",
      note: `Advantage+ automatic placements but only ${sizesStr} — some placements may crop or letterbox this size.`,
    };
  }
  const p = fi?.placements;
  if (p) {
    const wantsStory =
      p.facebook_positions.some((x) => x.includes("story") || x.includes("reel")) ||
      p.instagram_positions.some((x) => x.includes("story") || x.includes("reel"));
    const wantsFeed = p.facebook_positions.includes("feed") || p.instagram_positions.includes("stream");
    const probs: string[] = [];
    if (wantsStory && !has916) probs.push("story/reels placement targeted but no 9:16 asset");
    if (wantsFeed && !hasFeed) probs.push("feed placement targeted but no 1:1/4:5 asset");
    if (probs.length) return { status: "warning", note: `${probs.join("; ")} (sizes: ${sizesStr}).` };
  }
  return { status: "pass", note: `Asset sizes: ${sizesStr} — no format conflict detected.` };
}
