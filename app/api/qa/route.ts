import { NextResponse } from "next/server";
import { createHash } from "crypto";
import Anthropic from "@anthropic-ai/sdk";
import { google } from "googleapis";
import sharp from "sharp";
import { getGoogleAuth } from "@/lib/google-auth";
import { resolveAdId, fetchAdContent, ALLOWED_ENHANCEMENT_KEYS, MANUAL_CHECK_ITEMS, type AiEnhancement, type FormatInfo, type CreativeImageContext } from "@/lib/meta-api";
import { computeCompletenessLine } from "@/lib/completeness";
import { isAuthedRequest } from "@/lib/auth";

// Allow up to 5 minutes — needed for multi-batch QA runs with image processing.
export const maxDuration = 300;

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// Diagnostic logging is gated behind QA_DEBUG so production logs stay quiet and
// never echo work-order copy or the model's chain-of-thought. Set QA_DEBUG=1
// to re-enable verbose tracing.
const dbg: (...args: unknown[]) => void =
  process.env.QA_DEBUG === "1" ? console.log.bind(console) : () => {};

const SYSTEM_PROMPT = `You are a QA reviewer for social media ads at a digital marketing agency. Your job is to check each ad unit against the work order provided.

For each ad unit you will receive:
- The ad unit name and preview link URL
- The ad creative content pulled directly from the Meta API (copy, headline, CTA, destination URL)

You may also receive labeled source documents pulled from Google Drive links in the work order:
- COPY DOCUMENT: The approved ad copy. Use this as the authoritative source for what copy should appear in the ad. Flag any word, phrase, offer detail, or CTA that differs from this doc — even minor variations.
- CREATIVE DOCUMENT / SPEC: The approved creative brief or spec. Use this to verify the creative direction, imagery descriptions, and visual theme match.
- DESTINATION URL: The approved landing page URL from the work order. Verify the ad's click-through URL matches exactly.

When these labeled documents are present, treat them as the primary source of truth over the WO summary text. Cross-reference each ad unit's actual copy and creative against the specific document provided for that purpose. Be explicit about what matches and what doesn't.

CRITICAL — IMAGE READING RULES (read before doing any visual check):
- An image's content is ONLY the pixels in that image. Never infer, assume, or describe text, dates, numbers, logos, or visual elements that you cannot actually see rendered in the pixels.
- Only report text (offers, dates, disclaimers, headlines) if it is literally legible in the image. If text is too small, blurry, or cut off to read with confidence, say it is "not legible" and set the check to "warning" — do NOT guess what it says.
- NEVER attribute text from the COPY DOCUMENT, CREATIVE DOCUMENT, or WORK ORDER to the image. Those are separate text sources. A date or phrase appearing in a document does NOT mean it appears in the creative, and vice versa.
- When you report that the image "says" or "shows" something, it must be something you can actually read in the pixels. If you are describing what should be there per the copy doc, say so explicitly rather than claiming the image shows it.
- Do not fabricate differences. Only flag a mismatch between the image and a document when you can actually read the conflicting text in the image.
- ANIMATED GIFS: a GIF creative is delivered as several extracted still frames, each labeled "(GIF frame i/N)". All frames with the same base filename are ONE creative whose content legitimately changes over time — do NOT flag differences BETWEEN frames of the same GIF as a defect. Instead, review the SET of frames together: every frame's text/imagery must be correct, and when comparing a live GIF against an approved Drive GIF, compare the whole frame set (e.g. the live GIF must contain both the "A" and "B" states the approved GIF shows).
- VIDEO CREATIVES: a video is represented by a SINGLE still frame on each side — an approved Drive video appears as an image named "... (Drive thumbnail frame)" and a live Meta video as an image labeled "VIDEO THUMBNAIL". Drive and Meta auto-select DIFFERENT frames of the same video, so text or imagery present in one frame but absent from the other is NOT a finding — never flag it. Compare only visual theme, branding, and DIRECTLY CONFLICTING legible text (e.g. two different offer amounts or dates, both clearly legible). One frame cannot verify a video's full content: when either side of a comparison is a video frame, creative_alignment can be at best "warning" (note that only a single frame was reviewed) — never "pass" — and "fail" only on a direct legible contradiction.

Review each ad unit on seven criteria:
1. copy_alignment — Does the ad copy text (post body, headline, CTA button text) exactly match the approved copy doc? Evaluate only the text-based content here — not the visual creative. Flag any word, phrase, offer detail, or CTA that differs from the approved copy doc. If no copy doc is provided, compare against the WO summary.
   TYPOGRAPHIC VARIANTS ARE NOT FINDINGS: curly vs straight quotes/apostrophes, hyphen vs en/em dash, "..." vs "…", differing whitespace or line breaks, and capitalization of an entire line (e.g. headline case) are platform formatting differences — treat them as matching. Flag only changes in actual words, numbers, offers, or meaning-bearing punctuation.
   AD/CREATIVE NAMES ARE NOT FINDINGS: the "Ad name:" and "Creative name:" lines are internal Meta metadata that never renders publicly. Never flag anything about them in ANY check — naming conventions, typos, or unresolved template tokens like {{product.name}} in a name are all out of scope. Use names only as format/placement hints.
2. creative_alignment — Does the visual creative match the approved Drive files? You may receive images from two sources:
   - APPROVED CREATIVE FROM DRIVE: the design files the client signed off on (labeled with their filenames). These are what the live ad is supposed to match.
   - LIVE META CREATIVE: the image(s) actually live in the Meta ad, shown per ad unit below.
   When images are provided, follow this three-step process:
   STEP 1 — TEXT EXTRACTION: Before comparing anything, read each image and list every piece of text you can literally see in the pixels (headlines, offer amounts, dates, disclaimers, CTAs, fine print). Record this separately for the approved Drive image and the live Meta image in the text_in_approved and text_in_live fields. If text is too small or blurry to read with confidence, write "not legible" for that item. If an image is present but contains no legible text at all, write "no text visible". Reserve null STRICTLY for when no image was provided for that source — never use null when an image exists.
   STEP 2 — COMPARISON: With the extracted text in hand, compare the two lists. Flag any difference — a word, number, date, or phrase that appears in one but not the other, or differs between them. Also check visual theme, colors, logo, and layout match. Match Drive assets to ad units by filename/concept and size (e.g. "1080x1920 V2", "Carousel"). If only one source is present, check what you can. If no images at all, note that visual creative could not be checked.
   STEP 3 — COPY DOC CROSS-CHECK (only when the COPY DOCUMENT specifies on-image / per-card copy): compare the live image text you extracted in STEP 1 against the on-image copy the doc assigns to THIS specific ad unit/variant/option. The live image matching the approved Drive file is NOT sufficient on its own — if the live and Drive images both carry on-image text that differs from what the copy doc assigns this unit (e.g. the cards carry a different option's copy), flag it and name which option the on-image text actually belongs to. Use only text literally extracted from the pixels in STEP 1 — the image-reading rules above still apply. If the copy doc does not specify on-image copy, skip this step and do not penalize the ad for it.
   The step names above (STEP 1/2/3) are internal instructions only — NEVER reference them in your notes or summary. Just state the issue plainly, e.g. "live cards carry Option 1 on-image copy; copy doc assigns Option 2 copy to this unit."
   COMPLETENESS IS NOT YOUR JOB TO INFER: each unit includes a "Creative completeness (computed)" line — a code-level inventory of exactly which sizes/cards the live ad actually serves vs what the approved Drive provides. Treat it as AUTHORITATIVE. NEVER report a size, aspect ratio (e.g. 1080×1920 / Story / vertical), or carousel card as "missing" or "extra" based on the set of images attached below — that set may be a representative SAMPLE, not the full ad. Only flag a missing/extra asset when the computed line explicitly says "GENUINE GAP". Your visual comparison is limited to whether the creative CONTENT you can actually see matches the approved Drive design; absence of an image from the attached set is never, by itself, a defect.
3. promo_month_date — Are any promo months, dates, or time-limited references correct? Flag stale or incorrect date references. Use the TODAY'S DATE line provided with the work order as the ground truth for what is current vs stale — never rely on your own sense of the current date. Only evaluate dates you can actually read — from the API copy text, the copy doc, or text legibly visible in the image. Never report a date as appearing in the creative unless you can literally read it in the pixels.
4. url_cta — Does the CTA match what was specified? For the destination URL, each ad unit includes a "URL comparison (computed)" line — a code-level comparison of the live URL(s) against the approved destination that already normalizes hosts/paths and ignores tracking parameters (utm_*, fbclid, etc.). Treat that computed verdict as authoritative for URL matching: do NOT re-derive URL matching yourself, and never flag tracking parameters as a mismatch. Your job in this check is the CTA (and echoing the computed URL verdict).
5. grammar_typos — Any grammar errors, typos, or awkward phrasing?
6. ai_enhancements — This check is computed automatically in code from the Meta API data, outside this review. Always return status "unknown" with an empty note for it; the system overwrites it.
7. format_size — This check is computed automatically in code from the creative dimensions and placement data, outside this review. Always return status "unknown" with an empty note for it; the system overwrites it. (The format & placement info shown per unit is provided as context for your visual checks only.)

For each check, assign one of:
- "pass" — looks correct
- "fail" — clear problem found
- "warning" — possible issue or couldn't fully verify
- "unknown" — data not available (only valid for ai_enhancements and format_size)

BE CONCISE BUT COMPLETE. Keep notes tight — roughly one short sentence per issue. If a check has more than one genuine problem, report ALL of them in that check's note (separate with "; "), most important first. Never drop a real issue for the sake of brevity — missing a defect is worse than a slightly longer note. Keep "summary" to one sentence. Do not use numbered lists inside note fields.

IMPORTANT: Submit your review by calling the \`submit_qa_report\` tool. Put everything in the tool call — do not write any prose in the text response. The tool expects exactly this structure:

{
  "overall_status": "pass" | "fail" | "warning",
  "units": [
    {
      "name": "string",
      "status": "pass" | "fail" | "warning",
      "checks": {
        "copy_alignment": { "status": "pass" | "fail" | "warning", "note": "≤25 words" },
        "creative_alignment": { "status": "pass" | "fail" | "warning", "note": "≤25 words", "text_in_approved": "all legible text from approved Drive image, or null", "text_in_live": "all legible text from live Meta image, or null" },
        "promo_month_date": { "status": "pass" | "fail" | "warning", "note": "≤25 words" },
        "url_cta": { "status": "pass" | "fail" | "warning", "note": "≤25 words" },
        "grammar_typos": { "status": "pass" | "fail" | "warning", "note": "≤25 words" },
        "ai_enhancements": { "status": "unknown", "note": "" },
        "format_size": { "status": "unknown", "note": "" }
      },
      "summary": "≤25 words"
    }
  ],
  "critical_issues": ["one issue per item, ≤20 words each — only the most urgent, max 5 total"],
  "notes": ""
}`;

// Status enum reused across every check in the tool schema.
const STATUS_ENUM = { type: "string", enum: ["pass", "fail", "warning", "unknown"] } as const;
const CHECK_SHAPE = {
  type: "object",
  properties: { status: STATUS_ENUM, note: { type: "string" } },
} as const;

// Structured-output tool. Having the model return its report through a
// schema-validated tool call (instead of free-text JSON) means the API hands us
// back a real object — there is no JSON string to parse, so an unescaped quote
// inside a note can no longer corrupt and crash the whole batch (the old
// "Expected ',' or '}'" failure). Caps on note length etc. stay enforced by the
// prompt, not the schema, to avoid over-constraining the model.
const QA_TOOL: Anthropic.Tool = {
  name: "submit_qa_report",
  description:
    "Submit the completed QA review for all ad units in this batch. Call this exactly once.",
  input_schema: {
    type: "object",
    properties: {
      overall_status: { type: "string", enum: ["pass", "fail", "warning"] },
      units: {
        type: "array",
        items: {
          type: "object",
          properties: {
            name: { type: "string" },
            status: { type: "string", enum: ["pass", "fail", "warning"] },
            checks: {
              type: "object",
              properties: {
                copy_alignment: CHECK_SHAPE,
                creative_alignment: {
                  type: "object",
                  properties: {
                    status: STATUS_ENUM,
                    note: { type: "string" },
                    text_in_approved: { type: ["string", "null"] },
                    text_in_live: { type: ["string", "null"] },
                  },
                },
                promo_month_date: CHECK_SHAPE,
                url_cta: CHECK_SHAPE,
                grammar_typos: CHECK_SHAPE,
                ai_enhancements: CHECK_SHAPE,
                format_size: CHECK_SHAPE,
              },
            },
            summary: { type: "string" },
          },
          required: ["name", "status", "checks", "summary"],
        },
      },
      critical_issues: { type: "array", items: { type: "string" } },
      notes: { type: "string" },
    },
    required: ["overall_status", "units"],
  },
};

type AdUnit = {
  name: string;
  link: string;
  // Ad set name (from campaign import). Used to hard-scope approved Drive
  // images to the matching ad set when approval subfolders are named after
  // ad sets (location-variant campaigns: "Walnut Creek/", "Hayward/", …).
  adsetName?: string;
};

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
function tokenize(s: string): string[] {
  return s
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length >= 2);
}

// ─── Deterministic checks (computed in code, not by the model) ──────────────
// url_cta URL matching, format_size, and ai_enhancements are pure logic over
// API data. Having the model re-derive them invited two failure modes: flubbed
// ratio/string comparisons (hallucinated findings) and run-to-run inconsistency.
// They are computed here and the model's output for those checks is overwritten.

type ComputedCheck = { status: "pass" | "fail" | "warning" | "unknown"; note: string };

// Query params that are tracking noise — never a URL mismatch finding.
const TRACKING_PARAM_RE = /^(utm_|fbclid$|gclid$|gbraid$|wbraid$|msclkid$|ttclid$|mc_cid$|mc_eid$|igshid$|ref$)/i;

function normalizeUrlForCompare(raw: string): { host: string; path: string; params: Map<string, string> } | null {
  try {
    const u = new URL(raw.trim());
    const host = u.hostname.toLowerCase().replace(/^www\./, "");
    const path = (u.pathname.replace(/\/+$/, "") || "/").toLowerCase();
    const params = new Map<string, string>();
    u.searchParams.forEach((v, k) => {
      if (!TRACKING_PARAM_RE.test(k)) params.set(k.toLowerCase(), v);
    });
    return { host, path, params };
  } catch {
    return null;
  }
}

// True when the live URL points at the approved destination: same host (www
// ignored) + same path (trailing slash/case ignored), and every meaningful
// (non-tracking) query param on the approved URL is present on the live URL.
// Extra non-tracking params on the live side are tolerated.
function urlsMatch(approved: string, live: string): boolean {
  const a = normalizeUrlForCompare(approved);
  const l = normalizeUrlForCompare(live);
  if (!a || !l) return false;
  if (a.host !== l.host || a.path !== l.path) return false;
  for (const [k, v] of Array.from(a.params.entries())) {
    if (l.params.get(k) !== v) return false;
  }
  return true;
}

// Pull every URL out of the formatted Meta creative content (Destination URL,
// Link URL, CTA URL, Landing URLs, carousel card urls all appear as plain text).
// Line-based so each URL can be tagged as a carousel-card URL ("  Card N: …")
// vs a primary destination — cards may legitimately deep-link to different
// pages on the approved domain, which must not hard-FAIL the whole ad.
function extractLiveUrls(content: string | null | undefined): { url: string; isCard: boolean }[] {
  if (!content) return [];
  const out: { url: string; isCard: boolean }[] = [];
  const seen = new Set<string>();
  for (const line of content.split("\n")) {
    const isCard = /^\s*Card \d+:/.test(line);
    for (const u of line.match(/https?:\/\/[^\s|,")\]]+/g) ?? []) {
      if (!seen.has(u)) {
        seen.add(u);
        out.push({ url: u, isCard });
      }
    }
  }
  return out;
}

function computeUrlComparisonLine(approvedUrl: string | null | undefined, content: string | null | undefined): string {
  // No approved URL in the WO → say so explicitly. Without this line the model
  // would eyeball-match URLs itself — the exact failure mode the computed
  // verdict exists to prevent.
  if (!approvedUrl) {
    return `\nURL comparison (computed): no approved destination URL was provided in the work order — do NOT judge URL matching; evaluate only the CTA.`;
  }
  const liveUrls = extractLiveUrls(content);
  if (!liveUrls.length) {
    return `\nURL comparison (computed): no destination URL found in the ad's creative fields — URL match could not be verified.`;
  }
  const mismatches = liveUrls.filter((u) => !urlsMatch(approvedUrl, u.url));
  if (!mismatches.length) {
    return `\nURL comparison (computed): all ${liveUrls.length} live URL(s) match the approved destination (host + path compared; tracking params ignored). URL matching = PASS; evaluate only the CTA.`;
  }
  // Split mismatches: a carousel-card URL on the approved HOST but a different
  // path is a deep-link (often intentional) → warning. Anything else — a
  // primary URL mismatch, or a card pointing at a different domain — is a FAIL.
  const approvedHost = normalizeUrlForCompare(approvedUrl)?.host ?? null;
  const sameHost = (u: string) =>
    !!approvedHost && normalizeUrlForCompare(u)?.host === approvedHost;
  const hardMismatches = mismatches.filter((m) => !m.isCard || !sameHost(m.url));
  const cardDeepLinks = mismatches.filter((m) => m.isCard && sameHost(m.url));
  if (hardMismatches.length) {
    return `\nURL comparison (computed): MISMATCH — these live URL(s) do not point at the approved destination ${approvedUrl}: ${hardMismatches.map((m) => m.url).join(" , ")}. URL matching = FAIL.`;
  }
  return `\nURL comparison (computed): primary destination matches the approved URL, but ${cardDeepLinks.length} carousel card URL(s) deep-link to other pages on the approved domain: ${cardDeepLinks.map((m) => m.url).join(" , ")}. URL matching = WARNING (verify the card deep-links are intentional); do not mark this a FAIL on URL matching alone.`;
}

// Same verdict as computeUrlComparisonLine, but as a status so the result
// assembly can make URL matching authoritative on the url_cta check (the model
// only judges the CTA). "unknown" = nothing to compare, so don't penalize.
function computeUrlMatchStatus(
  approvedUrl: string | null | undefined,
  content: string | null | undefined
): "pass" | "fail" | "warning" | "unknown" {
  if (!approvedUrl) return "unknown";
  const liveUrls = extractLiveUrls(content);
  if (!liveUrls.length) return "unknown";
  const mismatches = liveUrls.filter((u) => !urlsMatch(approvedUrl, u.url));
  if (!mismatches.length) return "pass";
  const approvedHost = normalizeUrlForCompare(approvedUrl)?.host ?? null;
  const sameHost = (u: string) =>
    !!approvedHost && normalizeUrlForCompare(u)?.host === approvedHost;
  const hardMismatches = mismatches.filter((m) => !m.isCard || !sameHost(m.url));
  if (hardMismatches.length) return "fail";
  return "warning"; // only carousel card deep-links differ
}

// format_size: name tokens are the primary intent signal, dimensions the
// evidence, placements the tiebreaker — same rules the prompt used to describe,
// now applied deterministically.
function classifyDim(width: number, height: number): "story" | "feed" | "landscape" | "other" {
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
function checkDimensionConsistency(fi: FormatInfo | null | undefined): { failNote: string | null; warnNote: string | null } {
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
function computeFormatSizeCheck(unitName: string, fi: FormatInfo | null | undefined): ComputedCheck {
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

function computePlacementFormatCheck(unitName: string, fi: FormatInfo | null | undefined): ComputedCheck {
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
  const expectsFeed =
    tokens.has("feed") || tokens.has("static") || tokens.has("1x1") || tokens.has("4x5") ||
    tokens.has("square") || /\b(1\s*:\s*1|4\s*:\s*5)\b/.test(rawName);

  const issues: string[] = [];
  if (expectsStory && !has916) {
    issues.push(`ad name indicates Story/Reel but no 9:16 asset exists (sizes: ${sizesStr}) — content will be cut off or letterboxed`);
  }
  if (expectsFeed && !hasFeed) {
    issues.push(`ad name indicates Feed/Static but no 1:1 or 4:5 asset exists (sizes: ${sizesStr}) — will appear cropped in feed`);
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

// ai_enhancements: a fixed decision over API booleans. `flaggedOn` feeds the
// status rollup — manual-reminder-only warnings must not block "All clear".
// Note phrasings ("are ON", "Manual check also required…", "must still be
// verified manually…") are load-bearing: the results page splits the manual
// tail and detects real findings via /\bON\b/ on this text.
function computeEnhancementsCheck(
  enhancements: AiEnhancement[] | null | undefined,
  manualItems: string[]
): { check: ComputedCheck; flaggedOn: boolean } {
  const manualList = manualItems.join(", ");
  if (!enhancements || !enhancements.length) {
    return {
      check: {
        status: "unknown",
        note: `API enhancement data unavailable. The following must be verified manually in Ads Manager: ${manualList}.`,
      },
      flaggedOn: false,
    };
  }
  const onNotAllowed = enhancements.filter((e) => e.status === "on" && !ALLOWED_ENHANCEMENT_KEYS.has(e.key));
  if (onNotAllowed.length) {
    const names = onNotAllowed.map((e) => e.label).join(", ");
    return {
      check: {
        status: "warning",
        note: `${names} ${onNotAllowed.length === 1 ? "is" : "are"} ON. Manual check also required in Ads Manager for: ${manualList}.`,
      },
      flaggedOn: true,
    };
  }
  return {
    check: {
      status: "warning",
      note: `All API-readable enhancements are off. The following must still be verified manually in Ads Manager: ${manualList}.`,
    },
    flaggedOn: false,
  };
}

// Deterministic status rollup: worst of the checks (fail > warning > pass;
// "unknown" doesn't penalize). ai_enhancements only counts when something is
// actually ON — its ever-present manual reminder previously made "All clear"
// unreachable (or model-dependent, varying run to run).
function rollupUnitStatus(
  checks: Record<string, { status?: string } | undefined>,
  enhancementFlaggedOn: boolean
): "pass" | "fail" | "warning" {
  let worst = 0;
  for (const [key, c] of Object.entries(checks)) {
    if (!c) continue;
    if (key === "ai_enhancements" && !enhancementFlaggedOn) continue;
    const r = c.status === "fail" ? 2 : c.status === "warning" ? 1 : 0;
    if (r > worst) worst = r;
  }
  return worst === 2 ? "fail" : worst === 1 ? "warning" : "pass";
}

type LabeledDoc = {
  label: string;
  content: string;
};

type ImageMediaType = "image/jpeg" | "image/png" | "image/webp" | "image/gif";
const ALLOWED_IMAGE_MEDIA_TYPES: ImageMediaType[] = ["image/jpeg", "image/png", "image/webp", "image/gif"];

// Video types Drive auto-generates thumbnails for.
const ALLOWED_VIDEO_MEDIA_TYPES = ["video/mp4", "video/quicktime", "video/x-msvideo", "video/webm", "video/x-matroska"];

// Lightweight reference passed from the browser — bytes are downloaded
// server-side below to keep the request body under Vercel's ~4.5MB limit.
type DriveImageRef = {
  id: string;
  name: string;
  mediaType: string;
};

type FetchedImage = { name: string; mediaType: ImageMediaType; data: string; context?: string | null };

// Anthropic allows up to 5MB per image; cap a touch below that.
const MAX_IMAGE_BYTES = 4_500_000;

// Resize an image buffer so its longest side is ≤ MAX_SIDE px.
// QA must read small overlay text — offer amounts, dates, disclaimers — so we keep
// images near Claude's optimal vision resolution (~1568px long edge). The old 768px
// at q75 blurred small text into an illegible smear, which caused the model to GUESS
// at dates/copy that weren't actually legible (hallucinated date/text findings).
const MAX_SIDE = 1568;
async function resizeForClaude(buf: Buffer): Promise<{ buf: Buffer; mediaType: ImageMediaType } | null> {
  try {
    // Validate it's actually a raster image first. A non-image (HTML error page,
    // a tracking pixel, a preview-scrape false positive) has no decodable
    // metadata and must NOT be sent to Claude — doing so returns a 400
    // "Could not process image" that fails the entire batch. The previous
    // version fell back to passing the raw bytes through, which is exactly what
    // caused that crash. Now: if it can't be decoded, we skip it (return null).
    const meta = await sharp(buf).metadata();
    if (!meta.width || !meta.height) return null;
    const resized = await sharp(buf)
      .resize(MAX_SIDE, MAX_SIDE, { fit: "inside", withoutEnlargement: true })
      .jpeg({ quality: 88 })
      .toBuffer();
    return { buf: resized, mediaType: "image/jpeg" };
  } catch {
    // Unsupported / corrupt / not-an-image — skip rather than send invalid bytes.
    return null;
  }
}

// Animated GIFs are mini slideshows — the creative's content CHANGES across
// frames (e.g. image A → image B). Sending the GIF whole means the model only
// ever sees one frame, so the other version(s) were never QA'd. Extract up to
// MAX_GIF_FRAMES evenly-spaced frames (always including first and last) and
// send each as its own labeled image so the full animation gets reviewed.
const MAX_GIF_FRAMES = 4;
type PreparedImage = {
  buf: Buffer;
  mediaType: ImageMediaType;
  frame?: { index: number; total: number }; // present only for animated-GIF frames (1-based)
};
async function prepareImageForClaude(raw: Buffer): Promise<PreparedImage[]> {
  try {
    const meta = await sharp(raw).metadata();
    if (!meta.width || !meta.height) return [];
    const pages = meta.pages ?? 1;
    if (meta.format === "gif" && pages > 1) {
      const n = Math.min(MAX_GIF_FRAMES, pages);
      // Evenly spaced 0-based page indices, first and last always included.
      const indices = Array.from(
        new Set(Array.from({ length: n }, (_, i) => Math.round((i * (pages - 1)) / (n - 1))))
      );
      const out: PreparedImage[] = [];
      for (const idx of indices) {
        try {
          const buf = await sharp(raw, { page: idx, pages: 1 })
            .resize(MAX_SIDE, MAX_SIDE, { fit: "inside", withoutEnlargement: true })
            .jpeg({ quality: 88 })
            .toBuffer();
          out.push({ buf, mediaType: "image/jpeg", frame: { index: idx + 1, total: pages } });
        } catch {
          // Skip an unreadable frame; remaining frames still get reviewed.
        }
      }
      if (out.length) {
        dbg(`[qa] Animated GIF: extracted ${out.length} of ${pages} frame(s) for review.`);
        return out;
      }
      // Frame extraction failed entirely — fall through to the static path.
    }
    const resized = await resizeForClaude(raw);
    return resized ? [resized] : [];
  } catch {
    return [];
  }
}

// SSRF guard: only allow https image downloads from known creative/CDN hosts.
// These URLs come from external API responses (Meta Graph, Google Drive), so we
// must not blindly fetch them — a manipulated response could point at internal
// addresses (e.g. cloud metadata 169.254.169.254) or other private services.
const ALLOWED_IMAGE_HOST_SUFFIXES = [
  ".fbcdn.net",
  ".facebook.com",
  "graph.facebook.com",
  ".cdninstagram.com",
  ".googleusercontent.com",
  ".ggpht.com",
];

function isSafeImageUrl(raw: string): boolean {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return false;
  }
  if (u.protocol !== "https:") return false;
  const host = u.hostname.toLowerCase();
  // Reject literal IP hosts outright (blocks private ranges + metadata IPs).
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(host) || host.includes(":")) return false;
  if (host === "localhost") return false;
  return ALLOWED_IMAGE_HOST_SUFFIXES.some(
    (suffix) => host === suffix.replace(/^\./, "") || host.endsWith(suffix)
  );
}

// Download a URL-based image server-side, resize, and return as base64.
// `context` (optional) is a human-readable placement/date note attached to this
// specific live image so the QA prompt can label it; null when the flag is off.
async function downloadUrlImage(url: string, context?: string | null): Promise<FetchedImage[]> {
  try {
    if (!isSafeImageUrl(url)) {
      dbg(`[qa] SKIP live image — host not in allowlist or unsafe URL: ${url}`);
      return [];
    }
    const res = await fetch(url, { cache: "no-store", redirect: "error" });
    if (!res.ok) {
      dbg(`[qa] SKIP live Meta image — HTTP ${res.status} for ${url}`);
      return [];
    }
    const rawBuf = Buffer.from(await res.arrayBuffer());
    const prepared = await prepareImageForClaude(rawBuf);
    if (!prepared.length) {
      dbg(`[qa] SKIP live Meta image — not a decodable image: ${url}`);
      return [];
    }
    const baseName = url.split("/").pop()?.split("?")[0] ?? "meta-creative.jpg";
    dbg(`[qa] DOWNLOADED live Meta image "${baseName}" (${(rawBuf.length / 1024).toFixed(0)} KB → ${prepared.length} image(s)).`);
    return prepared.map((p) => ({
      name: p.frame ? `${baseName} (GIF frame ${p.frame.index}/${p.frame.total})` : baseName,
      mediaType: p.mediaType,
      data: p.buf.toString("base64"),
      context: p.frame
        ? `${context ? `${context} — ` : ""}animated GIF, extracted frame ${p.frame.index} of ${p.frame.total}`
        : context ?? null,
    }));
  } catch (err) {
    const msg = err instanceof Error ? err.message : "unknown error";
    dbg(`[qa] SKIP live Meta image — download failed: ${msg}`);
    return [];
  }
}

// Download the queued Drive images server-side (no Vercel body limit here).
// Returns a map of ref.name → one or more prepared images (animated GIFs expand
// into multiple labeled frames; everything else stays a single image).
async function downloadDriveImages(refs: DriveImageRef[]): Promise<Map<string, FetchedImage[]>> {
  const out = new Map<string, FetchedImage[]>();
  if (!refs.length) return out;
  const drive = google.drive({ version: "v3", auth: await getGoogleAuth() });

  // Download in parallel — sequential was needless latency.
  await Promise.all(
    refs.map(async (ref): Promise<void> => {
      const isVideo = ALLOWED_VIDEO_MEDIA_TYPES.includes(ref.mediaType);
      const isImage = (ALLOWED_IMAGE_MEDIA_TYPES as string[]).includes(ref.mediaType);
      if (!ref.id || (!isImage && !isVideo)) {
        dbg(`[qa] SKIP "${ref.name}" — unsupported type ${ref.mediaType}.`);
        return;
      }
      try {
        if (isVideo) {
          // On Vercel there is no ffmpeg binary, so we can't decode the raw video.
          // Instead, request the Drive-generated thumbnail — Drive processes every
          // uploaded video and produces a JPEG preview frame, accessible via
          // thumbnailLink. We bump the size to 1568px to match the image QA
          // resolution so Claude can read overlay text and branding clearly.
          const metaRes = await drive.files.get({
            fileId: ref.id,
            fields: "thumbnailLink",
            supportsAllDrives: true,
          });
          const rawThumbUrl = metaRes.data.thumbnailLink;
          if (!rawThumbUrl) {
            dbg(`[qa] SKIP video "${ref.name}" — Drive has not generated a thumbnail yet (file may still be processing).`);
            return;
          }
          // Drive thumbnails default to small sizes; swap in =s1568 for a larger frame.
          const thumbUrl = rawThumbUrl.replace(/=s\d+$/, "=s1568");
          const imgs = await downloadUrlImage(thumbUrl);
          if (imgs.length) {
            out.set(ref.name, imgs.map((img) => ({ ...img, name: `${ref.name} (Drive thumbnail frame)` })));
            dbg(`[qa] DOWNLOADED Drive thumbnail for video "${ref.name}" → cross-referenced.`);
          } else {
            dbg(`[qa] SKIP video "${ref.name}" — Drive thumbnail URL returned no image.`);
          }
          return;
        }

        const res = await drive.files.get(
          { fileId: ref.id, alt: "media", supportsAllDrives: true },
          { responseType: "arraybuffer" }
        );
        const rawBuf = Buffer.from(res.data as ArrayBuffer);
        const prepared = await prepareImageForClaude(rawBuf);
        if (!prepared.length) {
          dbg(`[qa] SKIP image "${ref.name}" — not a decodable image.`);
          return;
        }
        dbg(`[qa] DOWNLOADED image "${ref.name}" (${(rawBuf.length / 1024).toFixed(0)} KB → ${prepared.length} image(s)) → cross-referenced.`);
        out.set(
          ref.name,
          prepared.map((p) => ({
            name: p.frame ? `${ref.name} (GIF frame ${p.frame.index}/${p.frame.total})` : ref.name,
            mediaType: p.mediaType,
            data: p.buf.toString("base64"),
          }))
        );
      } catch (err) {
        const msg = err instanceof Error ? err.message : "unknown error";
        dbg(`[qa] SKIP "${ref.name}" — download failed: ${msg}`);
      }
    })
  );
  return out;
}

export async function POST(request: Request) {
  if (!isAuthedRequest(request)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const { wo, units, labeledDocs, destinationUrl, driveImages, ignoreCopyDoc, instructions } = (await request.json()) as {
    wo: string;
    units: AdUnit[];
    labeledDocs?: LabeledDoc[];
    destinationUrl?: string | null;
    driveImages?: DriveImageRef[];
    ignoreCopyDoc?: boolean;
    instructions?: string;
  };

  if (!wo || !units?.length) {
    return NextResponse.json(
      { error: "Missing work order or ad units" },
      { status: 400 }
    );
  }

  const accessToken: string | undefined = process.env.META_ACCESS_TOKEN;
  if (!accessToken) {
    return NextResponse.json(
      { error: "META_ACCESS_TOKEN environment variable is not set." },
      { status: 500 }
    );
  }
  // Narrowed alias so the (hoisted) resolveUnit closure sees a guaranteed string.
  const metaToken: string = accessToken;

  if (!process.env.ANTHROPIC_API_KEY) {
    return NextResponse.json(
      { error: "ANTHROPIC_API_KEY environment variable is not set." },
      { status: 500 }
    );
  }

  // Resolve each unit: extract ad ID → fetch from Meta API.
  // Each fetchAdContent fans out to several Meta sub-requests, so resolving every
  // unit at once would fire hundreds/thousands of concurrent requests on a large
  // campaign and trip Meta's rate limits. Run through a bounded worker pool
  // instead; results are written back by index to preserve unit order.
  async function resolveUnit(unit: AdUnit) {
    const adId = await resolveAdId(unit.link);
    if (!adId) {
      return {
        ...unit,
        adId: null,
        content: null,
        note: "Could not extract an ad ID from this URL.",
      };
    }

    const { content, error, aiEnhancements, formatInfo, creativeImageUrls, creativeImageContext, manualCheckItems } = await fetchAdContent(adId, metaToken);

    // Build a per-URL context note (placement + asset date + stale flag) so each
    // downloaded image can be labeled in the prompt. Empty when the flag is off.
    const contextByUrl = new Map<string, string>();
    for (const c of (creativeImageContext ?? []) as CreativeImageContext[]) {
      const bits: string[] = [];
      if (c.videoThumbnail) bits.push("VIDEO THUMBNAIL: a single auto-selected frame of a video creative — NOT the full video");
      if (c.placement) bits.push(`serves placement(s): ${c.placement}`);
      if (c.assetDate) bits.push(`asset uploaded: ${c.assetDate}`);
      if (c.staleNote) bits.push(`⚠️ ${c.staleNote}`);
      if (bits.length) contextByUrl.set(c.url, bits.join(" — "));
    }

    // Download live Meta images server-side so we can pass them as base64
    // (Meta CDN URLs are blocked by robots.txt when passed directly to Claude).
    const creativeImages: FetchedImage[] = (
      await Promise.all((creativeImageUrls ?? []).map((u) => downloadUrlImage(u, contextByUrl.get(u))))
    ).flat();

    return {
      ...unit,
      adId,
      content,
      aiEnhancements,
      formatInfo,
      creativeImageUrls,
      creativeImages,
      manualCheckItems,
      note: content ? null : (error ?? "Meta API returned no content."),
    };
  }

  const MAX_CONCURRENT_META_FETCHES = 8;
  const unitContents: Awaited<ReturnType<typeof resolveUnit>>[] = new Array(units.length);
  let nextUnitIndex = 0;
  const metaWorker = async (): Promise<void> => {
    while (true) {
      const i = nextUnitIndex++;
      if (i >= units.length) return;
      unitContents[i] = await resolveUnit(units[i]);
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(MAX_CONCURRENT_META_FETCHES, units.length) }, () => metaWorker())
  );

  // Build labeled source docs section
  const sourceSections: string[] = [];

  if (labeledDocs && labeledDocs.length > 0) {
    for (const doc of labeledDocs) {
      // When ignoreCopyDoc is set the frontend already strips copy docs from the
      // payload, but guard here too so the label doesn't sneak through.
      if (ignoreCopyDoc && doc.label.toUpperCase().includes("COPY")) continue;
      const sectionTitle = doc.label.toUpperCase().includes("COPY")
        ? "COPY DOCUMENT (approved copy — authoritative source for ad copy)"
        : doc.label.toUpperCase().includes("CREATIVE")
        ? "CREATIVE DOCUMENT / SPEC (approved creative brief)"
        : `SOURCE DOCUMENT [${doc.label}]`;
      sourceSections.push(`\n\n${sectionTitle}:\n${doc.content}`);
    }
  }

  if (destinationUrl) {
    sourceSections.push(`\n\nDESTINATION URL (approved landing page from WO):\n${destinationUrl}`);
  }

  // When ignoreCopyDoc is on, tell the model explicitly so it doesn't wait for
  // a copy doc that isn't coming and evaluates copy_alignment + CTA against the WO only.
  if (ignoreCopyDoc) {
    sourceSections.push(`\n\nCOPY REVIEW MODE: No copy document has been provided for this run. There is NO copy document — do not reference, cite, or hallucinate one. For ALL text-based checks — copy_alignment AND the CTA button text portion of url_cta — evaluate only against the WORK ORDER SUMMARY above. If the work order does not specify a CTA button type, treat the live CTA as acceptable and mark url_cta pass. Do not flag a CTA mismatch based on any copy document language. Do not penalize the ad for the absence of a copy doc.`);
  }

  // Ground the model's sense of "now" — promo_month_date staleness judgments
  // are meaningless without it (the model's internal "today" is its training
  // date, not the run date).
  const todayLine = `TODAY'S DATE: ${new Date().toISOString().slice(0, 10)} — use this as ground truth when judging whether promo months/dates are current or stale.`;

  // Reviewer notes — optional free-text context that ADDS focus to the audit
  // (e.g. "pay attention to the disclaimer copy", "the resort name is spelled
  // 'Tahoe'"). These are a supplement, NOT an override: the full default QA
  // always runs and no check is skipped or softened because of them. Appended
  // last so they read as the most recent context.
  if (instructions?.trim()) {
    sourceSections.push(`\n\nREVIEWER NOTES (supplemental context from the reviewer — keep these in mind while running your normal full QA, but do not skip or reduce any checks because of them):\n${instructions.trim()}`);
  }

  const woSection = `${todayLine}\n\nWORK ORDER SUMMARY:\n${wo}${sourceSections.join("")}`;

  // Build the user message — multi-modal: text + image blocks per unit
  type CacheControl = { cache_control?: { type: "ephemeral" } };
  type ContentBlock =
    | ({ type: "text"; text: string } & CacheControl)
    | { type: "image"; source: { type: "url"; url: string } }
    | { type: "image"; source: { type: "base64"; media_type: ImageMediaType; data: string } };

  // Cap how many Drive images we attach to ANY single ad unit. A WO that links
  // Drive folders can surface dozens of assets (every size variant, old versions,
  // source files). The previous matcher dumped ALL of them onto a unit whose name
  // had no long keywords, and otherwise matched on a single shared word — so one
  // unit ended up with 40+ images and a Claude call so large it timed the function
  // out. We now rank by how many words from the unit name appear in the filename
  // and keep only the best few. No match → no Drive comparison for that unit
  // (the prompt already handles a missing approved image gracefully).
  // A static concept normally has several size variants (e.g. 1080x1080 and
  // 1080x1920) plus multiple design variants per size. 4 was too low: it let a
  // single size monopolize all the slots, so other sizes were never sent to the
  // model and got reported as "missing". 8 covers the common 3-square + 3-tall
  // layouts with margin; carousels still bump higher below.
  const MAX_DRIVE_IMAGES_PER_UNIT = 8;
  const allDriveRefs = driveImages ?? [];

  // A "Copy of …" file in a duplicate approval folder is the SAME creative as
  // the primary file — it must not consume a per-unit slot that a different
  // size/variant needs. Normalize to a creative key (drop folder path + any
  // "Copy of" prefix) and prefer the primary (non-"Copy of") file.
  const isCopyAsset = (n: string) => /(^|\/)\s*copy of\s+/i.test(n);
  const creativeKeyOf = (n: string) =>
    (n.split("/").pop() ?? n).replace(/^\s*copy of\s+/i, "").trim().toLowerCase();
  // Extract a size token ("1080x1920") from a filename, or "other" when absent.
  // Used to guarantee every distinct size is represented before the cap fills.
  const sizeKeyOf = (n: string) =>
    (n.match(/(\d{3,4})\s*x\s*(\d{3,4})/i)?.[0] ?? "other").replace(/\s+/g, "").toLowerCase();

  // Pre-compute document frequency of each token across ALL Drive image names.
  // A token in every file (e.g. "june", "hrok", the concept name) carries no
  // signal and gets weight ~0; a rare token ("v1", "static") gets high weight.
  // This is what makes matching general across clients — it learns which tokens
  // are distinctive from the files themselves rather than hardcoding names.
  const refTokenSets = allDriveRefs.map((r) => new Set(tokenize(r.name)));
  const docFreq = new Map<string, number>();
  refTokenSets.forEach((toks) => {
    toks.forEach((t) => docFreq.set(t, (docFreq.get(t) ?? 0) + 1));
  });
  const totalRefs = allDriveRefs.length;
  const idf = (t: string) => Math.log((totalRefs + 1) / ((docFreq.get(t) ?? 0) + 1));

  // Is this AD UNIT a carousel? Name is the primary signal ("Carousel" in the
  // name); the Meta-fetched content is a backup (formatCreative emits a
  // "Carousel cards (" block for carousel ads).
  function unitIsCarousel(unit: { name?: string | null; content?: string | null }): boolean {
    if ((unit.name ?? "").toLowerCase().includes("carousel")) return true;
    return (unit.content ?? "").toLowerCase().includes("carousel cards");
  }
  // Is this DRIVE FILE a carousel asset? Match the FILENAME or its immediate
  // parent folder only (carousels live in a "Carousels/" subfolder or carry
  // "Carousel" in the filename). A distant ancestor like a campaign-level
  // "Summer Carousel Push/" must NOT retag every static beneath it.
  const refIsCarousel = (name: string) => {
    const segs = name.toLowerCase().split("/");
    return segs.slice(-2).some((s) => s.includes("carousel"));
  };

  // ── AD-SET FOLDER SCOPING ────────────────────────────────────────────────
  // Location/variant campaigns keep each ad set's approved images in a folder
  // NAMED AFTER the ad set ("Walnut Creek/" ↔ the Walnut Creek ad set). Token
  // scoring alone can't enforce that mapping — if the location name doesn't
  // appear in the ad name/copy, the wrong folder's creative can win. Rule: a
  // Drive ref is scoped to an ad set when one of its folder path segments,
  // after dropping generic structure words, has ALL its tokens present in the
  // ad set name. Scoping only narrows when it actually discriminates (some
  // refs match, some don't) — otherwise everything falls back to TF-IDF as
  // before, so normal retargeting/interests/lookalike campaigns are unaffected.
  const GENERIC_FOLDER_TOKEN =
    /^(for|approval|approvals|approved|client|creative|creatives|carousel|carousels|static|statics|gif|gifs|video|videos|image|images|img|final|finals|export|exports|option|options|v?\d+|\d+x\d+)$/;
  function folderSegments(qualifiedName: string): string[] {
    return qualifiedName.split("/").slice(0, -1);
  }
  function segmentMatchesAdset(segment: string, adsetTokens: Set<string>): boolean {
    const segTokens = tokenize(segment).filter((t) => !GENERIC_FOLDER_TOKEN.test(t));
    return segTokens.length > 0 && segTokens.every((t) => adsetTokens.has(t));
  }

  // Returns the matched refs plus `crossFormat`: true when the matched approved
  // assets are the OPPOSITE format of the unit (carousel unit → static files or
  // vice versa, via the fallback paths below). The prompt then tells the model
  // to compare offer/text/theme only — not layout — so the fallback doesn't
  // produce "wrong layout" false flags.
  type RankedRefs = { refs: DriveImageRef[]; crossFormat: boolean };
  function rankRefsForUnit(unit: { name?: string | null; content?: string | null; adsetName?: string }): RankedRefs {
    const unitName = unit.name ?? "";
    if (!allDriveRefs.length) return { refs: [], crossFormat: false };
    // Build token set from the unit name AND the ad body copy from the Meta API.
    // Unit names are often generic ("May Static V1", "May Carousel V2") — they
    // encode format and version but NOT the campaign concept. The ad copy, on the
    // other hand, contains campaign-specific terms like "Fry's", "Amazon", or
    // "Multiplier" that appear in the Drive folder path ("Fry's GC Giveaway/",
    // "Amazon GC Giveaway/") and carry high IDF. Without content tokens, all V1
    // images from every concept score identically on "v1" alone, and the wrong
    // campaign's creative gets picked (alphabetically first wins). With content
    // tokens, the concept-name terms break the tie and route each unit to its
    // own campaign's Drive folder.
    const unitTokens = new Set([
      ...tokenize(unitName),
      ...tokenize(unit.content ?? ""),
    ]);
    if (!unitTokens.size) return { refs: [], crossFormat: false };

    // FORMAT-TYPE GATE — the fix for static units being QA'd against carousel
    // designs (and vice versa). Token overlap alone can't tell them apart when
    // the only shared tokens are the campaign/month words that appear in every
    // filename, so a static unit would pull in carousel files that genuinely
    // exist in the folder → the model reads offer text off the wrong asset and
    // reports it as a defect ("image has X" where X is from another creative).
    //   - Carousel unit  → only carousel assets are eligible (fall back to all
    //     if the folder has none, so we don't lose the comparison entirely).
    //   - Non-carousel unit (static/story/feed/reel) → prefer non-carousel assets,
    //     but fall back to carousel assets when the Drive folder has none (happens
    //     when the campaign uses the same creative for both formats and the files
    //     aren't named separately). This mirrors the carousel-unit fallback above
    //     so we always attempt a comparison rather than silently skipping it.
    // Apply ad-set folder scoping first (see comment above). The original
    // index `i` is preserved so refTokenSets/idf lookups stay valid.
    let pool = allDriveRefs.map((ref, i) => ({ ref, i }));
    const adsetName = unit.adsetName ?? "";
    if (adsetName) {
      const adsetTokens = new Set(tokenize(adsetName));
      const scoped = pool.filter(({ ref }) =>
        folderSegments(ref.name).some((s) => segmentMatchesAdset(s, adsetTokens))
      );
      if (scoped.length > 0 && scoped.length < pool.length) {
        dbg(
          `[qa] AD-SET SCOPE: unit "${unitName}" (ad set "${adsetName}") → ${scoped.length}/${pool.length} Drive image(s) in matching folder(s).`
        );
        pool = scoped;
      }
    }

    const carouselUnit = unitIsCarousel(unit);
    let eligible = pool;
    if (carouselUnit) {
      const onlyCarousel = eligible.filter((x) => refIsCarousel(x.ref.name));
      // Fall back to static/non-carousel assets when no carousel-labeled files
      // exist — same creative, not separately named.
      eligible = onlyCarousel.length > 0 ? onlyCarousel : eligible.filter((x) => !refIsCarousel(x.ref.name));
      // If still nothing (e.g. only unrelated files), keep the scoped pool.
      if (!eligible.length) eligible = pool;
    } else {
      const nonCarousel = eligible.filter((x) => !refIsCarousel(x.ref.name));
      // Fall back to carousel Drive assets when no static/story assets exist —
      // same creative, different format label.
      eligible = nonCarousel.length > 0 ? nonCarousel : eligible;
    }
    if (!eligible.length) return { refs: [], crossFormat: false };

    const scored = eligible
      .map(({ ref, i }) => {
        let score = 0;
        unitTokens.forEach((t) => {
          if (refTokenSets[i].has(t)) score += idf(t);
        });
        return { ref, score };
      })
      .filter((x) => x.score > 0) // require at least one shared token
      .sort((a, b) => b.score - a.score);

    if (!scored.length) return { refs: [], crossFormat: false }; // no match → no Drive comparison for this unit

    // Keep only images close to the best score (so a unit doesn't pull in
    // weakly-related extras from the wrong version), capped.
    const best = scored[0].score;
    let filtered = scored.filter((x) => x.score >= best * 0.5);

    // Version-token discrimination: if the unit name contains a version token
    // (v1, v2, v3…) AND at least one matched file also carries that token, drop
    // any file that carries a DIFFERENT version token. This prevents Static V1
    // from receiving v2 files (and vice versa) when all variants share the same
    // Drive folder and differ only by "v1"/"v2" in the filename.
    const VERSION_TOKEN = /^v\d+$/;
    const unitVersionTokens = Array.from(unitTokens).filter((t) => VERSION_TOKEN.test(t));
    if (unitVersionTokens.length > 0) {
      const refToks = (x: { ref: DriveImageRef }) => tokenize(x.ref.name);
      const hasVersionMatch = filtered.some((x) =>
        unitVersionTokens.some((vt) => refToks(x).includes(vt))
      );
      if (hasVersionMatch) {
        filtered = filtered.filter((x) => {
          const toks = refToks(x);
          // Keep if it has at least one matching version token
          if (unitVersionTokens.some((vt) => toks.includes(vt))) return true;
          // OR has NO version token at all (version-agnostic asset)
          return !toks.some((t) => VERSION_TOKEN.test(t));
        });
      }
    }

    // For carousel units, raise the per-unit cap to cover all cards (carousels
    // can have 6+ cards, each needing its own approved image for comparison).
    const perUnitCap = carouselUnit ? Math.max(MAX_DRIVE_IMAGES_PER_UNIT, 10) : MAX_DRIVE_IMAGES_PER_UNIT;

    // 1) Collapse "Copy of …" duplicates onto the primary creative so duplicate
    //    copies of one size don't crowd out other sizes. Keep the primary file
    //    when both exist; otherwise the higher-scored ref.
    const byCreative = new Map<string, { ref: DriveImageRef; score: number }>();
    for (const x of filtered) {
      const k = creativeKeyOf(x.ref.name);
      const cur = byCreative.get(k);
      if (!cur) {
        byCreative.set(k, x);
      } else {
        const curCopy = isCopyAsset(cur.ref.name);
        const xCopy = isCopyAsset(x.ref.name);
        if (curCopy && !xCopy) byCreative.set(k, x);
        else if (curCopy === xCopy && x.score > cur.score) byCreative.set(k, x);
      }
    }
    const deduped = Array.from(byCreative.values()).sort((a, b) => b.score - a.score);

    // 2) Bucket by size, then pick round-robin across sizes so EVERY size is
    //    represented before any single size takes a second slot. This is the
    //    fix for "other sizing isn't apparent" — previously one size could fill
    //    all 4 slots and the rest were silently dropped.
    const bySize = new Map<string, { ref: DriveImageRef; score: number }[]>();
    for (const x of deduped) {
      const k = sizeKeyOf(x.ref.name);
      const bucket = bySize.get(k) ?? [];
      bucket.push(x);
      bySize.set(k, bucket);
    }
    const sizeQueues = Array.from(bySize.values()); // each already score-sorted
    const picked: { ref: DriveImageRef; score: number }[] = [];
    let rr = 0;
    while (picked.length < perUnitCap && sizeQueues.some((q) => q.length > 0)) {
      const q = sizeQueues[rr % sizeQueues.length];
      if (q.length > 0) picked.push(q.shift()!);
      rr++;
    }
    const refs = picked.sort((a, b) => b.score - a.score).map((x) => x.ref);
    // Did the fallback hand this unit opposite-format approved assets?
    const crossFormat = carouselUnit
      ? refs.some((r) => !refIsCarousel(r.name))
      : refs.some((r) => refIsCarousel(r.name));
    if (crossFormat) {
      dbg(
        `[qa] CROSS-FORMAT FALLBACK: unit "${unitName}" (${carouselUnit ? "carousel" : "non-carousel"}) matched opposite-format approved file(s): ${refs.map((r) => r.name).join(" | ")}`
      );
    }
    return { refs, crossFormat };
  }

  // Match first, then download ONLY the images actually used by some unit —
  // no point downloading 40 assets when a handful are referenced.
  const refsPerUnit = unitContents.map((u) => rankRefsForUnit(u));
  const neededIds = new Set<string>();
  for (const ranked of refsPerUnit) for (const r of ranked.refs) neededIds.add(r.id);
  // Map of ref.name → prepared image(s); animated GIFs expand to several frames.
  const driveByName = await downloadDriveImages(allDriveRefs.filter((r) => neededIds.has(r.id)));

  // Build content blocks for a single ad unit (text + image blocks)
  function buildUnitBlocks(
    unit: (typeof unitContents)[number],
    unitDriveImages: FetchedImage[]
  ): ContentBlock[] {
    const blocks: ContentBlock[] = [];

    const contentBlock = unit.content
      ? `Ad creative content (from Meta API):\n${unit.content}`
      : `Note: ${unit.note ?? "Could not retrieve ad content."} Mark all checks as warning.`;
    const urlLine = unit.link ? `\nURL: ${unit.link}` : "";

    // AI enhancements are no longer shown to the model — that check is computed
    // deterministically in code (computeEnhancementsCheck) and overwritten on
    // the parsed result, so sending the toggle list was pure token cost.

    // Deterministic URL comparison — computed in code so the model never
    // eyeball-matches URLs (and tracking params can't cause false fails).
    const urlComparisonLine = computeUrlComparisonLine(destinationUrl, unit.content);

    // Format & placement block
    let formatBlock = "";
    const fi = (unit as { formatInfo?: FormatInfo | null }).formatInfo;

    // Deterministic creative-completeness — computed from the authoritative live
    // inventory + approved Drive sizes, so the model never reports a size/card
    // "missing" from a capped/sampled image set.
    const completenessLine = computeCompletenessLine(fi?.creativeInventory, unitDriveImages);
    if (fi) {
      const lines: string[] = [];
      if (fi.placements) {
        if (fi.placements.automatic) {
          lines.push(`  Placements: Advantage+ automatic (Meta selects placements dynamically — no explicit positions set)`);
        } else {
          const p = fi.placements;
          if (p.publisher_platforms.length) lines.push(`  Platforms: ${p.publisher_platforms.join(", ")}`);
          if (p.facebook_positions.length) lines.push(`  Facebook positions: ${p.facebook_positions.join(", ")}`);
          if (p.instagram_positions.length) lines.push(`  Instagram positions: ${p.instagram_positions.join(", ")}`);
          if (p.messenger_positions.length) lines.push(`  Messenger positions: ${p.messenger_positions.join(", ")}`);
          if (p.audience_network_positions.length) lines.push(`  Audience Network positions: ${p.audience_network_positions.join(", ")}`);
        }
      }
      if (fi.creativeDimensions.length > 0) {
        const dimStrings = fi.creativeDimensions.map(({ width, height }) => {
          const ratio = width / height;
          let placement = "unknown format";
          if (ratio >= 0.54 && ratio <= 0.58) placement = "Story / Reels (9:16)";
          else if (ratio >= 0.78 && ratio <= 0.82) placement = "Feed vertical (4:5)";
          else if (ratio >= 0.98 && ratio <= 1.02) placement = "Feed square (1:1)";
          else if (ratio >= 1.88 && ratio <= 1.94) placement = "Feed landscape (1.91:1)";
          return `${width}×${height} → ${placement}`;
        });
        lines.push(`  Creative asset sizes:\n${dimStrings.map(s => `    ${s}`).join("\n")}`);
      }
      if (fi.adFormats.length > 0) {
        lines.push(`  Ad formats: ${fi.adFormats.join(", ")}`);
      }
      formatBlock = lines.length > 0
        ? `\nFormat & placement info (from Meta API):\n${lines.join("\n")}`
        : "\nFormat & placement info: not available for this ad.";
    } else {
      formatBlock = "\nFormat & placement info: not available for this ad.";
    }

    // Live Meta creative images (pre-downloaded as base64)
    const liveImages = (unit as { creativeImages?: FetchedImage[] }).creativeImages ?? [];
    const imageNote = liveImages.length > 0
      ? `\nLive Meta creative: ${liveImages.length} image(s) follow below for visual review.`
      : unitDriveImages.length > 0
      ? "\nLive Meta creative: no live image returned by the Meta API for this ad — check the approved Drive creative above against this unit's copy/spec and note that the live Meta image could not be retrieved for a direct comparison."
      : "\nCreative images: not available — visual creative check cannot be performed.";

    blocks.push({
      type: "text",
      text: `\n---\nAd unit: ${unit.name || "Unnamed"}${urlLine}\n${contentBlock}${urlComparisonLine}${completenessLine}${formatBlock}${imageNote}`,
    });

    for (const img of liveImages) {
      // When placement/date context is present, label the image just before it
      // so the model can attribute placement and flag a stale-dated asset as a
      // real finding (rather than surfacing old creative as a phantom).
      if (img.context) {
        blocks.push({ type: "text", text: `\nLive Meta image — ${img.context}:` });
      }
      blocks.push({ type: "image", source: { type: "base64", media_type: img.mediaType, data: img.data } });
    }

    return blocks;
  }

  // Call the Claude API for one batch of units + their Drive images
  async function runBatch(
    batchUnits: (typeof unitContents),
    batchDriveImages: FetchedImage[],
    crossFormat = false
  ): Promise<{ units: unknown[]; critical_issues: string[]; notes: string }> {
    const messageContent: ContentBlock[] = [];

    // The work-order section is identical across every batch — cache it too so
    // it isn't re-billed per batch. This is a second cache breakpoint after the
    // system prompt.
    messageContent.push({ type: "text", text: woSection, cache_control: { type: "ephemeral" } });

    if (batchDriveImages.length > 0) {
      // Cross-format fallback: the only approved assets found are the opposite
      // format of this unit (e.g. carousel exports for a static ad). The design
      // is shared, the layout is not — scope the comparison so layout/card-count
      // differences don't become false flags.
      const crossFormatNote = crossFormat
        ? ` NOTE: the approved file(s) below are a DIFFERENT FORMAT than this ad unit (carousel vs static/story) — the campaign reuses one design across formats. Compare offer details, dates, on-image text, and visual theme ONLY; do NOT flag layout, card count, crop, or aspect-ratio differences as defects.`
        : "";
      messageContent.push({
        type: "text",
        text: `\n\nAPPROVED CREATIVE FROM DRIVE (${batchDriveImages.length} image(s) — these are the signed-off designs the live Meta ads should match; match each to an ad unit by filename/concept/size):${crossFormatNote}`,
      });
      for (const img of batchDriveImages) {
        messageContent.push({ type: "text", text: `\nApproved creative file: ${img.name}` });
        messageContent.push({
          type: "image",
          source: { type: "base64", media_type: img.mediaType, data: img.data },
        });
      }
    }

    messageContent.push({ type: "text", text: `\n\nAD UNITS TO REVIEW:` });

    for (const unit of batchUnits) {
      const unitDriveImages = batchDriveImages; // already pre-filtered for this batch
      for (const block of buildUnitBlocks(unit, unitDriveImages)) {
        messageContent.push(block);
      }
    }

    // --- DEBUG: exactly which images the model is about to see ---------------
    // The single most common cause of a phantom "image is wrong / has X" finding
    // is the model being handed the WRONG approved Drive file (e.g. a carousel
    // asset matched to a static unit) or a stale live pool image. Log the precise
    // filenames going into this call so a bad finding can be traced to its input.
    for (const unit of batchUnits) {
      const liveNames = ((unit as { creativeImages?: FetchedImage[] }).creativeImages ?? []).map((i) => i.name);
      dbg(
        `[qa][sent] unit="${unit.name || "Unnamed"}" adId=${unit.adId ?? "?"} | ` +
          `approvedDrive(${batchDriveImages.length})=[${batchDriveImages.map((d) => d.name).join(" | ")}] | ` +
          `liveMeta(${liveNames.length})=[${liveNames.join(" | ")}]`
      );
    }

    // Retry on 429 rate-limit errors. Improvements over the old loop:
    //  - More attempts (5 vs 3) so transient spikes recover instead of failing.
    //  - Respect the server's `retry-after` header when present — it tells us
    //    exactly how long until tokens replenish, so we don't retry too early.
    //  - Exponential backoff (5s,10s,20s,40s, capped 60s) when no header.
    //  - Random jitter so concurrent workers don't retry in lockstep and
    //    collide again (the old fixed 15s/30s caused exactly that thundering herd).
    const MAX_ATTEMPTS = 5;
    let message: Anthropic.Message | undefined;
    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
      try {
        message = await client.messages.create({
          model: "claude-sonnet-4-6",
          max_tokens: 16000,
          // Extended thinking: give the model a private scratchpad to do the
          // multi-step work this QA demands (extract all legible text from each
          // image, then diff the two; reason about dates/format) BEFORE it
          // commits to JSON. This materially cuts missed mismatches and
          // hallucinated findings. Thinking tokens bill as output — the
          // intentional "spend a little more for accuracy" trade.
          // NOTE: the API requires temperature=1 (the default) whenever
          // thinking is enabled, so temperature is intentionally not set.
          // budget_tokens must be < max_tokens.
          thinking: { type: "enabled", budget_tokens: 1500 },
          // Structured output: the model returns its report by calling this tool,
          // so the result arrives as a validated object rather than free-text
          // JSON we have to parse (and that used to crash on unescaped quotes).
          // tool_choice stays "auto" because extended thinking does not allow a
          // forced tool choice; the prompt instructs the model to call it, and a
          // text-JSON fallback below covers the rare case it answers without it.
          tools: [QA_TOOL],
          tool_choice: { type: "auto" },
          // Cache the large, unchanging system prompt so it is billed at full
          // price only once (~5 min TTL); subsequent batches/runs read it at
          // ~10% cost. cache_control marks the end of the cached prefix.
          system: [
            { type: "text", text: SYSTEM_PROMPT, cache_control: { type: "ephemeral" } },
          ],
          messages: [{ role: "user", content: messageContent }],
        });
        break;
      } catch (err) {
        const status = (err as { status?: number })?.status;
        // Retry transient failures, not just 429s: 529 ("overloaded_error") and
        // 5xx server errors previously failed the whole batch on the first hit
        // even though a short backoff almost always recovers them.
        const isRateLimit =
          status === 429 || (err instanceof Error && err.message.includes("rate_limit"));
        const isTransient =
          isRateLimit ||
          status === 529 ||
          (typeof status === "number" && status >= 500) ||
          (err instanceof Error && err.message.includes("overloaded"));
        if (isTransient && attempt < MAX_ATTEMPTS - 1) {
          // Prefer the server's retry-after (seconds); else exponential backoff.
          const headers = (err as { headers?: Record<string, string> })?.headers;
          const retryAfter = headers ? Number(headers["retry-after"]) : NaN;
          const base =
            Number.isFinite(retryAfter) && retryAfter > 0
              ? retryAfter * 1000
              : Math.min(60_000, 5_000 * 2 ** attempt);
          const jitter = Math.floor(Math.random() * 3_000);
          const wait = base + jitter;
          dbg(
            `[qa] Rate limited — waiting ${(wait / 1000).toFixed(1)}s before retry ${attempt + 2}/${MAX_ATTEMPTS}`
          );
          await new Promise((r) => setTimeout(r, wait));
        } else {
          throw err;
        }
      }
    }
    if (!message) throw new Error("Failed to get response from Claude after retries.");

    // Token-usage log — added to monitor cost/latency after raising image
    // resolution to 1568px (bigger images = more input tokens per run).
    // Sonnet 4.6 pricing per million tokens: $3 input, $15 output,
    // $3.75 cache write, $0.30 cache read. Cost here is an estimate.
    {
      const u = message.usage;
      const inTok = u.input_tokens ?? 0;
      const outTok = u.output_tokens ?? 0;
      const cacheWrite = u.cache_creation_input_tokens ?? 0;
      const cacheRead = u.cache_read_input_tokens ?? 0;
      const estCost =
        (inTok * 3 + outTok * 15 + cacheWrite * 3.75 + cacheRead * 0.3) / 1_000_000;
      dbg(
        `[qa] TOKENS input=${inTok} output=${outTok} cache_write=${cacheWrite} cache_read=${cacheRead} | ~$${estCost.toFixed(4)} (est)`
      );
    }

    if (message.stop_reason === "max_tokens") {
      throw new Error(
        `Response was cut off (too many ad units in batch). Try reviewing fewer campaigns at once.`
      );
    }

    // --- DEBUG: the model's private reasoning -------------------------------
    // Surface the extended-thinking block so we can see HOW the model arrived at
    // a finding — e.g. whether it confused two images, or read text off the wrong
    // asset. This is the raw chain-of-thought for this batch.
    {
      const thinkBlock = message.content.find((b) => b.type === "thinking");
      const thinkText =
        thinkBlock && thinkBlock.type === "thinking" ? thinkBlock.thinking : "(no thinking block returned)";
      dbg(`[qa][think] unit="${batchUnits.map((u) => u.name || "Unnamed").join(", ")}":\n${thinkText}`);
    }

    // Prefer the structured tool result. When the model calls submit_qa_report,
    // its input is schema-validated by the API and handed back as a real object,
    // so there is no JSON string to parse and no way for an unescaped quote in a
    // note to corrupt the batch (the old crash). Fall back to extracting JSON
    // from a text block only if the model answered without the tool.
    type ParsedQa = {
      units?: Record<string, unknown>[];
      critical_issues?: string[];
      notes?: string;
    };
    let parsed: ParsedQa;
    const toolUse = message.content.find((b) => b.type === "tool_use");
    if (toolUse && toolUse.type === "tool_use") {
      parsed = (toolUse.input ?? {}) as ParsedQa;
    } else {
      // Fallback path: pull the JSON object out of a text block (legacy).
      const textBlock = message.content.find((b) => b.type === "text");
      const raw = textBlock && textBlock.type === "text" ? textBlock.text : "";
      const jsonMatch = raw.match(/\{[\s\S]*\}/);
      if (!jsonMatch) throw new Error("No tool call or JSON object found in model response");
      try {
        parsed = JSON.parse(jsonMatch[0]);
      } catch (parseErr) {
        console.error("Raw model response (first 500 chars):", raw.slice(0, 500));
        throw parseErr;
      }
    }

    // Be defensive: a tool/JSON response can occasionally hand back `units` or
    // `critical_issues` as something other than an array. `?? []` only guards
    // null/undefined, so a non-array value slipped through and threw
    // "(parsed.units ?? []).map is not a function", failing the whole batch.
    const parsedUnits: Record<string, unknown>[] = Array.isArray(parsed.units) ? parsed.units : [];
    const rawCritical: string[] = Array.isArray(parsed.critical_issues) ? parsed.critical_issues : [];

    // Drop model-authored criticals about checks the code owns and overwrites
    // (ai_enhancements, format_size, URL matching). The model is told to leave
    // those as placeholders, but it can still surface a critical that
    // contradicts the deterministic result — a false flag in the issues card.
    const CODE_OWNED_CRITICAL_RE =
      /(enhancement|advantage\+|aspect ratio|\bdimensions?\b|image size|asset size|\b9:16\b|\b4:5\b|\b1:1\b|letterbox|tracking param|utm_)/i;
    const parsedCritical = rawCritical.filter((c) => {
      if (CODE_OWNED_CRITICAL_RE.test(c)) {
        dbg(`[qa][guard] dropped model critical about a code-owned check: "${c}"`);
        return false;
      }
      return true;
    });

    // --- DEBUG: text the model claims it read from each image ---------------
    // The two-step prompt records every legible string the model saw in the
    // approved Drive image vs the live Meta image. Logging these side by side is
    // the fastest way to catch a hallucinated finding: if text_in_approved shows
    // an offer/date that isn't actually in that asset, the model invented it (or
    // was handed the wrong file — cross-check against the [qa][sent] line above).
    for (const u of parsedUnits) {
      const checks = u?.checks as Record<string, Record<string, unknown>> | undefined;
      const cca = checks?.creative_alignment;
      if (cca) {
        dbg(
          `[qa][extract] "${String(u.name)}" status=${String(cca.status)} | ` +
            `text_in_approved=${JSON.stringify(cca.text_in_approved ?? null)} | ` +
            `text_in_live=${JSON.stringify(cca.text_in_live ?? null)}`
        );
      }
    }

    // --- GUARDS: creative_alignment can't be green without a real comparison ---
    // The prompt tells the model "if only one source is present, check what you
    // can", which lets it PASS a creative it never actually compared. Enforce
    // deterministically — a "pass" is downgraded to "warning" when:
    //  1. No approved Drive image reached the model (it only eyeballed the live).
    //  2. No live Meta image was retrievable (it only eyeballed the approved).
    //  3. Neither image was available at all.
    //  4. Images WERE sent but the model returned null for the corresponding
    //     text-extraction field — STEP 1 was skipped, so the pass is unverified.
    //     (Safe to enforce: the prompt reserves null for "no image provided";
    //     textless creatives must be reported as "no text visible".)
    // A unit-level "pass" is downgraded along with it so the card color
    // reflects the weakest check.
    parsedUnits.forEach((u, idx) => {
      const liveImgsArr =
        ((batchUnits[idx] ?? batchUnits[0]) as { creativeImages?: FetchedImage[] } | undefined)
          ?.creativeImages ?? [];
      const hasLive = liveImgsArr.length > 0;
      const hasDrive = batchDriveImages.length > 0;
      // 5. Either side of the comparison was a video thumbnail — ONE auto-selected
      //    frame can't verify the video's full content (offers/dates/disclaimers
      //    often appear mid-video), so a "pass" overstates what was checked.
      const videoFrameInvolved =
        liveImgsArr.some((i) => (i.context ?? "").includes("VIDEO THUMBNAIL")) ||
        batchDriveImages.some((d) => d.name.includes("(Drive thumbnail frame)"));
      const checks = u?.checks as Record<string, Record<string, unknown>> | undefined;
      const cca = checks?.creative_alignment;
      if (!cca || cca.status !== "pass") return;
      const extracted = (v: unknown) => typeof v === "string" && v.trim().length > 0;
      let reason: string | null = null;
      if (!hasLive && !hasDrive) {
        reason = "No creative images were available — visual creative could not be verified.";
      } else if (hasLive && !hasDrive) {
        reason = "Approved Drive asset not available for comparison — could not fully verify.";
      } else if (hasDrive && !hasLive) {
        reason = "Live Meta image could not be retrieved — could not fully verify against the approved creative.";
      } else if (videoFrameInvolved) {
        reason = "Comparison included a single video thumbnail frame — full video content not verified.";
      } else if (!extracted(cca.text_in_approved)) {
        reason = "No text was extracted from the approved image — visual comparison not verifiable.";
      } else if (!extracted(cca.text_in_live)) {
        reason = "No text was extracted from the live image — visual comparison not verifiable.";
      }
      if (!reason) return;
      cca.status = "warning";
      const existing = typeof cca.note === "string" && cca.note.trim() ? `${cca.note.trim()} ` : "";
      cca.note = `${existing}(${reason})`.trim();
      if (u.status === "pass") u.status = "warning";
      dbg(
        `[qa][guard] "${String(u.name)}" creative_alignment pass→warning — ${reason}`
      );
    });

    // Attach the resolved ad ID to each result unit so the report can show a
    // copy/paste-able ID. The model output isn't trusted to echo it — we map by
    // index back to the batch's input units (one unit per batch here), falling
    // back to the first unit's ID for any extra result units the model emits.
    const resultUnits = parsedUnits.map(
      (u: Record<string, unknown>, idx: number) => ({
        ...u,
        adId: batchUnits[idx]?.adId ?? batchUnits[0]?.adId ?? null,
      })
    );

    return {
      units: resultUnits,
      critical_issues: parsedCritical,
      notes: typeof parsed.notes === "string" ? parsed.notes : "",
    };
  }

  // --- Deduplicate identical ad versions before QA ---
  // Campaigns often ship the same creative as several near-identical ad units
  // (e.g. three carousels that are the same copy + creative). QA'ing each one
  // separately is pure waste: identical input → identical result, at 3x the
  // tokens and time. We fingerprint every unit from the EXACT data that feeds
  // the model — copy/creative content, AI-enhancement states, format/placement,
  // manual items, the actual live creative image bytes (hashed), the matched
  // approved Drive assets, and the format-relevant tokens in the name — then run
  // QA on only ONE representative per group and clone its result to the rest.
  // Accuracy is preserved because any unit that differs on ANY checked field
  // gets a different fingerprint, so it does NOT collapse: it stays its own
  // group and its ad ID is reported individually. Naming-only differences
  // (Carousel 1 vs 2 vs 3, V1/V2/V3) are normalized away so true duplicates
  // still merge.

  // Pull only the format-discriminating tokens out of a name. The model uses the
  // ad name solely as a hint for the format/size check (Story/Feed/Reel/1x1/
  // 9x16…), so two units differing only by a version/index number are
  // QA-equivalent and should fingerprint the same.
  function nameSignature(name: string): string {
    return tokenize(name)
      .filter((t) => !/^v?\d+$/.test(t)) // drop pure numbers and v1/v2/v3 tags
      .sort()
      .join(" ");
  }

  const sha1 = (s: string) => createHash("sha1").update(s).digest("hex");

  // A unit's fingerprint is built from everything that determines its QA
  // outcome. Live creative images are identified by a hash of their actual
  // bytes (not the Meta CDN URL, which carries per-request tokens) so two ads
  // with pixel-identical creative collapse while any visual difference splits.
  // We return the parts separately so we can log a per-FIELD hash and see
  // exactly which field makes two "identical" ads diverge.
  // The Meta content block starts with "Ad name: <name>" (and sometimes a
  // "Creative name:" line) — per-ad identity, not QA substance. Leaving it in
  // the fingerprint made every differently-named duplicate ("Carousel 1" vs
  // "Carousel 2") hash differently, so dedup never fired and identical ads were
  // QA'd repeatedly. Strip those lines; name-derived format signal is already
  // captured separately via nameSignature().
  function contentForFingerprint(content: string | null | undefined): string | null {
    if (!content) return null;
    return content
      .split("\n")
      .filter((line) => !/^(Ad name|Creative name):/.test(line))
      .join("\n");
  }

  function fingerprintParts(i: number): Record<string, unknown> {
    const u = unitContents[i];
    const enh = (u as { aiEnhancements?: AiEnhancement[] | null }).aiEnhancements ?? [];
    const manual = (u as { manualCheckItems?: string[] }).manualCheckItems ?? [];
    const liveImgs = (u as { creativeImages?: FetchedImage[] }).creativeImages ?? [];
    return {
      content: contentForFingerprint(u.content),
      note: u.note ?? null,
      enh: enh.map((e) => `${e.label}:${e.status}`).sort(),
      manual: [...manual].sort(),
      fmt: (u as { formatInfo?: FormatInfo | null }).formatInfo ?? null,
      liveImgHashes: liveImgs.map((img) => sha1(img.data)).sort(),
      driveImgs: refsPerUnit[i].refs.map((r) => r.name).sort(),
      driveCrossFormat: refsPerUnit[i].crossFormat,
      nameSig: nameSignature(u.name ?? ""),
    };
  }
  function fingerprintForUnit(i: number): string {
    return JSON.stringify(fingerprintParts(i));
  }

  // Assign each unit to a group keyed by fingerprint; the first unit with a
  // given fingerprint is that group's representative (the one we actually QA).
  const fpToRep = new Map<string, number>();
  const repOfUnit: number[] = new Array(unitContents.length);
  const repIndices: number[] = [];
  for (let i = 0; i < unitContents.length; i++) {
    const fp = fingerprintForUnit(i);
    if (!fpToRep.has(fp)) {
      fpToRep.set(fp, i);
      repIndices.push(i);
    }
    repOfUnit[i] = fpToRep.get(fp)!;
  }

  // --- DEBUG: per-field fingerprint hashes ---------------------------------
  // For each unit, log a short hash of every fingerprint field plus the raw
  // small fields. To find why two "identical" ads don't merge, compare their
  // lines: every field hash will match EXCEPT the one(s) that actually differ.
  // Remove this block once dedup behaviour is confirmed in production.
  const shortHash = (v: unknown) => sha1(JSON.stringify(v)).slice(0, 8);
  for (let i = 0; i < unitContents.length; i++) {
    const p = fingerprintParts(i);
    const fieldHashes = Object.fromEntries(
      Object.entries(p).map(([k, v]) => [k, shortHash(v)])
    );
    dbg(
      `[qa][fp] unit#${i} "${unitContents[i].name}" adId=${unitContents[i].adId ?? "?"} ` +
        `→ group#${repOfUnit[i]} | fields=${JSON.stringify(fieldHashes)} | ` +
        `nameSig="${p.nameSig}" liveImgs=${(p.liveImgHashes as string[]).length} ` +
        `driveImgs=${JSON.stringify(p.driveImgs)} contentLen=${(unitContents[i].content ?? "").length}`
    );
  }
  dbg(
    `[qa][fp] grouped ${unitContents.length} unit(s) into ${repIndices.length} unique version(s).`
  );

  // Members (original unit indices) per representative, preserving input order.
  const membersOfRep = new Map<number, number[]>();
  for (let i = 0; i < unitContents.length; i++) {
    const rep = repOfUnit[i];
    if (!membersOfRep.has(rep)) membersOfRep.set(rep, []);
    membersOfRep.get(rep)!.push(i);
  }

  // --- Build batches: ONE representative ad unit per Claude call ---
  // Bundling several units + up to a dozen images into one multimodal call was
  // the real cause of the 300s timeouts: vision input + large output generation
  // is slow, so a heavy campaign's few big calls could each take 100s+. A single
  // unit (its text + its 1-2 live images + its matched Drive images) is a small,
  // fast call (~5-15s). Many of these run concurrently and fail in isolation,
  // keeping every request comfortably under Vercel's limit. We only call Claude
  // for representatives — duplicate versions reuse the representative's result.
  type Batch = { units: (typeof unitContents); driveImages: FetchedImage[]; crossFormat: boolean };
  const batches: Batch[] = repIndices.map((i) => ({
    units: [unitContents[i]],
    driveImages: refsPerUnit[i].refs.flatMap((r) => driveByName.get(r.name) ?? []),
    crossFormat: refsPerUnit[i].crossFormat,
  }));

  dbg(
    `[qa] ${unitContents.length} ad unit(s) → ${batches.length} unique version(s); running ${batches.length} Claude call(s) (saved ${unitContents.length - batches.length}).`
  );

  // Run per-unit calls concurrently with a cap. Raised from 2→4 after reviewing
  // production logs: zero 429s observed, and per-call token volume (~9-13k input)
  // is low enough that 4 concurrent stays well under rate limits. The hardened
  // retry/backoff absorbs any remaining bursts. Results stay ordered (written back
  // to their index).
  const MAX_CONCURRENT_BATCHES = 4;

  try {
    const batchResults: Awaited<ReturnType<typeof runBatch>>[] = new Array(batches.length);
    let nextIndex = 0;

    const worker = async (): Promise<void> => {
      while (true) {
        const i = nextIndex++;
        if (i >= batches.length) return;
        const b = batches[i];
        dbg(`[qa] Batch ${i + 1}/${batches.length}: ${b.units.length} unit(s), ${b.driveImages.length} Drive image(s).`);
        batchResults[i] = await runBatch(b.units, b.driveImages, b.crossFormat);
      }
    };

    await Promise.all(
      Array.from({ length: Math.min(MAX_CONCURRENT_BATCHES, batches.length) }, () => worker())
    );

    // Merge batch results. Each batch is one representative, so batchResults[k]
    // holds the QA result for repIndices[k]. Emit ONE result unit per group,
    // carrying the representative's checks plus the full list of ad units the
    // result covers (name + ad ID) so the report can render a single
    // consolidated card and list every ad ID it applies to.
    const allUnits = repIndices.map((repIdx, k) => {
      const base = (batchResults[k]?.units?.[0] ?? {}) as Record<string, unknown>;
      const group = (membersOfRep.get(repIdx) ?? [repIdx]).map((i) => ({
        name: unitContents[i].name || "Unnamed",
        adId: unitContents[i].adId ?? null,
      }));
      // A batch can occasionally return no usable unit (model emitted an empty
      // or malformed `units` array), leaving `base` as `{}` — i.e. no `checks`
      // and no `status`. The UI maps Object.entries(unit.checks) over every
      // unit, so a unit without `checks` crashed the whole results page. Supply
      // a safe default so a single bad unit degrades to a "couldn't verify"
      // card instead of taking the report down.
      const hasChecks =
        base.checks !== null && typeof base.checks === "object";
      const safeChecks = (hasChecks
        ? base.checks
        : {
            copy_alignment: { status: "unknown", note: "No result returned for this ad — re-run the QA." },
            creative_alignment: { status: "unknown", note: "No result returned." },
            promo_month_date: { status: "unknown", note: "No result returned." },
            url_cta: { status: "unknown", note: "No result returned." },
            grammar_typos: { status: "unknown", note: "No result returned." },
            ai_enhancements: { status: "unknown", note: "No result returned." },
            format_size: { status: "unknown", note: "No result returned." },
          }) as Record<string, { status?: string; note?: string }>;

      // Overwrite the deterministic checks with code-computed results — the
      // model is instructed to leave these as unknown/"" placeholders.
      const rep = unitContents[repIdx];
      const enhResult = computeEnhancementsCheck(
        (rep as { aiEnhancements?: AiEnhancement[] | null }).aiEnhancements,
        (rep as { manualCheckItems?: string[] }).manualCheckItems ?? MANUAL_CHECK_ITEMS
      );
      const finalChecks = {
        ...safeChecks,
        ai_enhancements: enhResult.check,
        format_size: computeFormatSizeCheck(
          rep.name ?? "",
          (rep as { formatInfo?: FormatInfo | null }).formatInfo
        ),
      };

      // Make URL matching authoritative: escalate url_cta to the code-computed
      // verdict so a real destination mismatch can't be hidden by the model. We
      // only ever escalate (never downgrade), so the model still owns the CTA
      // judgment. "unknown" means there was nothing to compare.
      {
        const urlComputed = computeUrlMatchStatus(destinationUrl, rep.content);
        const sev = (s?: string) => (s === "fail" ? 2 : s === "warning" ? 1 : 0);
        const urlCheck = (finalChecks as Record<string, { status?: string; note?: string }>).url_cta;
        if (urlCheck && urlComputed !== "unknown" && sev(urlComputed) > sev(urlCheck.status)) {
          urlCheck.status = urlComputed;
          const tag =
            urlComputed === "fail"
              ? "Live destination URL does not match the approved URL (computed)."
              : "Carousel card URL(s) deep-link off the approved page (computed) — verify intentional.";
          urlCheck.note = urlCheck.note ? `${urlCheck.note} ${tag}` : tag;
        }
      }

      // Size profile for the CLIENT-SIDE cross-ad comparison (V1 vs V2 statics,
      // carousel vs carousel). Campaigns are chunked into multiple /api/qa
      // requests, so comparing across ads can only happen once the browser has
      // every chunk's results — the server just ships the raw image sizes.
      const repFi = (rep as { formatInfo?: FormatInfo | null }).formatInfo;
      const sizeProfile = {
        isCarousel: unitIsCarousel(rep),
        imageSizes: (repFi?.imageDimensions ?? []).map((d) => `${d.width}×${d.height}`),
      };

      return {
        ...base,
        checks: finalChecks,
        // Deterministic rollup — worst of the checks. The model's own status
        // field is ignored: it had no defined rollup rule and varied run to run.
        status: rollupUnitStatus(finalChecks, enhResult.flaggedOn),
        summary: typeof base.summary === "string" ? base.summary : "",
        name: unitContents[repIdx].name || "Unnamed",
        adId: unitContents[repIdx].adId ?? null,
        group,
        groupSize: group.length,
        sizeProfile,
      };
    });
    const allCritical = batchResults.flatMap((r) => r.critical_issues);
    const allNotes = "";

    const statusPriority = (s: string) => (s === "fail" ? 2 : s === "warning" ? 1 : 0);
    const worstStatus = (allUnits as { status?: string }[]).reduce(
      (worst, u) => (statusPriority(u.status ?? "pass") > statusPriority(worst) ? (u.status ?? "pass") : worst),
      "pass"
    );

    return NextResponse.json({
      overall_status: worstStatus,
      units: allUnits,
      critical_issues: allCritical,
      notes: allNotes,
    });
  } catch (err) {
    // Non-Error throws (plain objects from SDKs / rejected promises) used to
    // hit String(err) → "[object Object]" in the UI banner, hiding the real
    // cause. Serialize them so the message is actionable.
    let message: string;
    if (err instanceof Error) {
      message = err.message || err.name;
    } else {
      try {
        message = typeof err === "string" ? err : JSON.stringify(err);
      } catch {
        message = String(err);
      }
    }
    console.error("QA API error:", message, err instanceof Error ? err.stack : err);
    return NextResponse.json(
      { error: `QA check failed: ${message}` },
      { status: 500 }
    );
  }
}
