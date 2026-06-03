import { NextResponse } from "next/server";
import { createHash } from "crypto";
import Anthropic from "@anthropic-ai/sdk";
import { google } from "googleapis";
import sharp from "sharp";
import { getOAuthClient } from "@/lib/google-auth";
import { cookies } from "next/headers";
import { resolveAdId, fetchAdContent, ALLOWED_ENHANCEMENT_KEYS, type AiEnhancement, type FormatInfo, type CreativeImageContext } from "@/lib/meta-api";

// Allow up to 5 minutes — needed for multi-batch QA runs with image processing.
export const maxDuration = 300;

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

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

Review each ad unit on six criteria:
1. copy_creative_alignment — Does the ad copy exactly match the approved copy doc? You may receive images from two sources:
   - APPROVED CREATIVE FROM DRIVE: the design files the client signed off on (labeled with their filenames). These are what the live ad is supposed to match.
   - LIVE META CREATIVE: the image(s) actually live in the Meta ad, shown per ad unit below.
   When images are provided, follow this two-step process:
   STEP 1 — TEXT EXTRACTION: Before comparing anything, read each image and list every piece of text you can literally see in the pixels (headlines, offer amounts, dates, disclaimers, CTAs, fine print). Record this separately for the approved Drive image and the live Meta image in the text_in_approved and text_in_live fields. If text is too small or blurry to read with confidence, write "not legible" for that item. If no image is present for a source, write null.
   STEP 2 — COMPARISON: With the extracted text in hand, compare the two lists. Flag any difference — a word, number, date, or phrase that appears in one but not the other, or differs between them. Also check visual theme, colors, logo, and layout match. Match Drive assets to ad units by filename/concept and size (e.g. "1080x1920 V2", "Carousel"). If only one source is present, check what you can. If no images at all, note that visual creative could not be checked.
2. promo_month_date — Are any promo months, dates, or time-limited references correct? Flag stale or incorrect date references. Only evaluate dates you can actually read — from the API copy text, the copy doc, or text legibly visible in the image. Never report a date as appearing in the creative unless you can literally read it in the pixels.
3. url_cta — Does the ad's destination URL match the approved URL exactly? Does the CTA match what was specified?
4. grammar_typos — Any grammar errors, typos, or awkward phrasing?
5. ai_enhancements — Are any Meta Advantage+ AI enhancements turned ON? You will receive two pieces of data:
   (a) API-checked enhancements: a list of enhancements and their on/off status fetched directly from the Meta API.
   (b) Manual check required: a list of enhancements that cannot be read from the API and must be verified by a human inside Meta Ads Manager.
   Evaluation rules:
   - Enhancements marked "(allowed ...)" are intentionally enabled. Treat them as acceptable: do NOT name them, do NOT include the word "ON" for them, and do NOT let them trigger a warning. Ignore them entirely.
   - If any non-allowed API-checked enhancement is ON: status = "warning", note = name all ON (non-allowed) enhancements, then add "Manual check also required in Ads Manager for: [list the manual items]."
   - If all non-allowed API-checked enhancements are OFF (allowed ones may be on): status = "warning", note = "All API-readable enhancements are off. The following must still be verified manually in Ads Manager: [list the manual items]."
   - If API enhancement data is absent: status = "unknown", note = "API enhancement data unavailable. The following must be verified manually in Ads Manager: [list the manual items]."
   Never return "pass" for ai_enhancements — manual items always require a human to verify.
6. format_size — Do the creative asset dimensions match the intended format(s) for this ad?
   You will receive "Creative asset sizes" listing every unique width×height found across the ad's creative assets, plus placement info and ad format type.
   Also use the ad unit name as a strong hint — names typically include "Story", "Feed", "Reel", "Static", "Video", "1x1", "9x16", "4x5", etc.
   Key Meta format requirements:
   - Feed (facebook: feed, instagram: stream): 1:1 (1080×1080, ratio 1.00) or 4:5 (1080×1350, ratio 0.80)
   - Stories (facebook: story, instagram: story): 9:16 (1080×1920, ratio 0.5625) — a 1:1 or 4:5 asset here means content will be cut off or letterboxed
   - Reels (instagram: reels): 9:16 (1080×1920, ratio 0.5625)
   - Right column (facebook: right_hand_column): 1.91:1
   Evaluation rules:
   - If the ad name says "Story" or "Reel" but creative dimensions are 1:1 or 4:5 → FAIL (wrong size, content will be cut off)
   - If the ad name says "Feed" or "Static" but creative dimensions are 9:16 → FAIL (wrong size, will appear cropped in feed)
   - If multiple sizes are present (e.g. both 1080×1080 and 1080×1920), check that each size is appropriate for its intended placement
   - If placement shows "Advantage+ automatic" and multiple sizes exist, pass if the sizes cover both feed and story formats
   - If placement shows "Advantage+ automatic" and only one size exists, warn if that size would be wrong for some placements
   - If creative dimensions are absent: status = "unknown", note = "Creative dimensions not available."
   - If placement data is absent but dimensions exist: evaluate based on ad name vs dimensions alone

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
        "copy_creative_alignment": { "status": "pass" | "fail" | "warning", "note": "≤25 words", "text_in_approved": "all legible text from approved Drive image, or null", "text_in_live": "all legible text from live Meta image, or null" },
        "promo_month_date": { "status": "pass" | "fail" | "warning", "note": "≤25 words" },
        "url_cta": { "status": "pass" | "fail" | "warning", "note": "≤25 words" },
        "grammar_typos": { "status": "pass" | "fail" | "warning", "note": "≤25 words" },
        "ai_enhancements": { "status": "warning" | "unknown", "note": "≤25 words" },
        "format_size": { "status": "pass" | "fail" | "warning" | "unknown", "note": "≤25 words" }
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
                copy_creative_alignment: {
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
};

type LabeledDoc = {
  label: string;
  content: string;
};

type ImageMediaType = "image/jpeg" | "image/png" | "image/webp" | "image/gif";
const ALLOWED_IMAGE_MEDIA_TYPES: ImageMediaType[] = ["image/jpeg", "image/png", "image/webp", "image/gif"];

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

// Download a URL-based image server-side, resize, and return as base64.
// `context` (optional) is a human-readable placement/date note attached to this
// specific live image so the QA prompt can label it; null when the flag is off.
async function downloadUrlImage(url: string, context?: string | null): Promise<FetchedImage | null> {
  try {
    const res = await fetch(url, { cache: "no-store" });
    if (!res.ok) {
      console.log(`[qa] SKIP live Meta image — HTTP ${res.status} for ${url}`);
      return null;
    }
    const rawBuf = Buffer.from(await res.arrayBuffer());
    const resized = await resizeForClaude(rawBuf);
    if (!resized) {
      console.log(`[qa] SKIP live Meta image — not a decodable image: ${url}`);
      return null;
    }
    const { buf, mediaType } = resized;
    const name = url.split("/").pop()?.split("?")[0] ?? "meta-creative.jpg";
    console.log(`[qa] DOWNLOADED live Meta image "${name}" (${(rawBuf.length / 1024).toFixed(0)} KB → ${(buf.length / 1024).toFixed(0)} KB resized).`);
    return { name, mediaType, data: buf.toString("base64"), context: context ?? null };
  } catch (err) {
    const msg = err instanceof Error ? err.message : "unknown error";
    console.log(`[qa] SKIP live Meta image — download failed: ${msg}`);
    return null;
  }
}

// Download the queued Drive images server-side (no Vercel body limit here).
async function downloadDriveImages(refs: DriveImageRef[]): Promise<FetchedImage[]> {
  if (!refs.length) return [];
  const cookieStore = await cookies();
  const cookieToken = cookieStore.get("google_refresh_token")?.value;
  const drive = google.drive({ version: "v3", auth: getOAuthClient(cookieToken) });

  // Download in parallel — sequential was needless latency.
  const results = await Promise.all(
    refs.map(async (ref): Promise<FetchedImage | null> => {
      if (!ref.id || !(ALLOWED_IMAGE_MEDIA_TYPES as string[]).includes(ref.mediaType)) {
        console.log(`[qa] SKIP image "${ref.name}" — unsupported type ${ref.mediaType}.`);
        return null;
      }
      try {
        const res = await drive.files.get(
          { fileId: ref.id, alt: "media", supportsAllDrives: true },
          { responseType: "arraybuffer" }
        );
        const rawBuf = Buffer.from(res.data as ArrayBuffer);
        const resized = await resizeForClaude(rawBuf);
        if (!resized) {
          console.log(`[qa] SKIP image "${ref.name}" — not a decodable image.`);
          return null;
        }
        const { buf, mediaType: resizedType } = resized;
        console.log(`[qa] DOWNLOADED image "${ref.name}" (${(rawBuf.length / 1024).toFixed(0)} KB → ${(buf.length / 1024).toFixed(0)} KB resized) → cross-referenced.`);
        return { name: ref.name, mediaType: resizedType, data: buf.toString("base64") };
      } catch (err) {
        const msg = err instanceof Error ? err.message : "unknown error";
        console.log(`[qa] SKIP image "${ref.name}" — download failed: ${msg}`);
        return null;
      }
    })
  );
  return results.filter((img): img is FetchedImage => img !== null);
}

export async function POST(request: Request) {
  const { wo, units, labeledDocs, destinationUrl, driveImages } = (await request.json()) as {
    wo: string;
    units: AdUnit[];
    labeledDocs?: LabeledDoc[];
    destinationUrl?: string | null;
    driveImages?: DriveImageRef[];
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
      if (c.placement) bits.push(`serves placement(s): ${c.placement}`);
      if (c.assetDate) bits.push(`asset uploaded: ${c.assetDate}`);
      if (c.staleNote) bits.push(`⚠️ ${c.staleNote}`);
      if (bits.length) contextByUrl.set(c.url, bits.join(" — "));
    }

    // Download live Meta images server-side so we can pass them as base64
    // (Meta CDN URLs are blocked by robots.txt when passed directly to Claude).
    const creativeImages: FetchedImage[] = (
      await Promise.all((creativeImageUrls ?? []).map((u) => downloadUrlImage(u, contextByUrl.get(u))))
    ).filter((img): img is FetchedImage => img !== null);

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

  const woSection = `WORK ORDER SUMMARY:\n${wo}${sourceSections.join("")}`;

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
  const MAX_DRIVE_IMAGES_PER_UNIT = 4;
  const allDriveRefs = driveImages ?? [];

  // Tokenize a name (filename or ad unit name) into lowercase alphanumeric
  // tokens. Keeps short-but-meaningful tokens like "v1", "v2", "1x1", "9x16"
  // (length ≥ 2) which are exactly the version/format discriminators we need.
  function tokenize(s: string): string[] {
    return s
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((t) => t.length >= 2);
  }

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
  // Is this DRIVE FILE a carousel asset? Their carousel exports live in a
  // "Carousels/" subfolder and carry "Carousel" in the filename.
  const refIsCarousel = (name: string) => name.toLowerCase().includes("carousel");

  function rankRefsForUnit(unit: { name?: string | null; content?: string | null }): DriveImageRef[] {
    const unitName = unit.name ?? "";
    if (!allDriveRefs.length) return [];
    const unitTokens = new Set(tokenize(unitName));
    if (!unitTokens.size) return [];

    // FORMAT-TYPE GATE — the fix for static units being QA'd against carousel
    // designs (and vice versa). Token overlap alone can't tell them apart when
    // the only shared tokens are the campaign/month words that appear in every
    // filename, so a static unit would pull in carousel files that genuinely
    // exist in the folder → the model reads offer text off the wrong asset and
    // reports it as a defect ("image has X" where X is from another creative).
    //   - Carousel unit  → only carousel assets are eligible (fall back to all
    //     if the folder has none, so we don't lose the comparison entirely).
    //   - Non-carousel unit (static/story/feed/reel) → carousel assets are never
    //     eligible. If that leaves nothing, we return no Drive image rather than
    //     comparing against the wrong creative (the prompt handles "no approved
    //     image" gracefully).
    const carouselUnit = unitIsCarousel(unit);
    let eligible = allDriveRefs.map((ref, i) => ({ ref, i }));
    if (carouselUnit) {
      const onlyCarousel = eligible.filter((x) => refIsCarousel(x.ref.name));
      if (onlyCarousel.length) eligible = onlyCarousel;
    } else {
      eligible = eligible.filter((x) => !refIsCarousel(x.ref.name));
    }
    if (!eligible.length) return [];

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

    if (!scored.length) return []; // no match → no Drive comparison for this unit

    // Keep only images close to the best score (so a unit doesn't pull in
    // weakly-related extras from the wrong version), capped.
    const best = scored[0].score;
    return scored
      .filter((x) => x.score >= best * 0.5)
      .slice(0, MAX_DRIVE_IMAGES_PER_UNIT)
      .map((x) => x.ref);
  }

  // Match first, then download ONLY the images actually used by some unit —
  // no point downloading 40 assets when a handful are referenced.
  const refsPerUnit = unitContents.map((u) => rankRefsForUnit(u));
  const neededIds = new Set<string>();
  for (const refs of refsPerUnit) for (const r of refs) neededIds.add(r.id);
  const downloadedDrive = await downloadDriveImages(allDriveRefs.filter((r) => neededIds.has(r.id)));
  const driveByName = new Map(downloadedDrive.map((img) => [img.name, img] as const));

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

    // AI enhancements block
    let enhancementsBlock = "";
    const enhancements = (unit as { aiEnhancements?: AiEnhancement[] | null }).aiEnhancements;
    const manualItems = (unit as { manualCheckItems?: string[] }).manualCheckItems ?? [];
    const manualList = manualItems.length > 0
      ? `\nEnhancements requiring manual verification in Ads Manager:\n${manualItems.map(i => `  - ${i}`).join("\n")}`
      : "";
    if (enhancements && enhancements.length > 0) {
      const lines = enhancements.map((e) => {
        if (e.status !== "on") return `  - ${e.label}: off`;
        // Allowed enhancements are intentionally always on — do not flag them.
        return ALLOWED_ENHANCEMENT_KEYS.has(e.key)
          ? `  - ${e.label}: on (allowed — intentionally enabled, do NOT flag or mention)`
          : `  - ${e.label}: ON ⚠️`;
      });
      enhancementsBlock = `\nMeta Advantage+ AI enhancements (from API):\n${lines.join("\n")}${manualList}`;
    } else {
      enhancementsBlock = `\nMeta Advantage+ AI enhancements: not available for this ad.${manualList}`;
    }

    // Format & placement block
    let formatBlock = "";
    const fi = (unit as { formatInfo?: FormatInfo | null }).formatInfo;
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
      text: `\n---\nAd unit: ${unit.name || "Unnamed"}${urlLine}\n${contentBlock}${enhancementsBlock}${formatBlock}${imageNote}`,
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
    batchDriveImages: FetchedImage[]
  ): Promise<{ units: unknown[]; critical_issues: string[]; notes: string }> {
    const messageContent: ContentBlock[] = [];

    // The work-order section is identical across every batch — cache it too so
    // it isn't re-billed per batch. This is a second cache breakpoint after the
    // system prompt.
    messageContent.push({ type: "text", text: woSection, cache_control: { type: "ephemeral" } });

    if (batchDriveImages.length > 0) {
      messageContent.push({
        type: "text",
        text: `\n\nAPPROVED CREATIVE FROM DRIVE (${batchDriveImages.length} image(s) — these are the signed-off designs the live Meta ads should match; match each to an ad unit by filename/concept/size):`,
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
      console.log(
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
          thinking: { type: "enabled", budget_tokens: 3000 },
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
        const isRateLimit =
          status === 429 || (err instanceof Error && err.message.includes("rate_limit"));
        if (isRateLimit && attempt < MAX_ATTEMPTS - 1) {
          // Prefer the server's retry-after (seconds); else exponential backoff.
          const headers = (err as { headers?: Record<string, string> })?.headers;
          const retryAfter = headers ? Number(headers["retry-after"]) : NaN;
          const base =
            Number.isFinite(retryAfter) && retryAfter > 0
              ? retryAfter * 1000
              : Math.min(60_000, 5_000 * 2 ** attempt);
          const jitter = Math.floor(Math.random() * 3_000);
          const wait = base + jitter;
          console.log(
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
      console.log(
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
      console.log(`[qa][think] unit="${batchUnits.map((u) => u.name || "Unnamed").join(", ")}":\n${thinkText}`);
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
    const parsedCritical: string[] = Array.isArray(parsed.critical_issues) ? parsed.critical_issues : [];

    // --- DEBUG: text the model claims it read from each image ---------------
    // The two-step prompt records every legible string the model saw in the
    // approved Drive image vs the live Meta image. Logging these side by side is
    // the fastest way to catch a hallucinated finding: if text_in_approved shows
    // an offer/date that isn't actually in that asset, the model invented it (or
    // was handed the wrong file — cross-check against the [qa][sent] line above).
    for (const u of parsedUnits) {
      const checks = u?.checks as Record<string, Record<string, unknown>> | undefined;
      const cca = checks?.copy_creative_alignment;
      if (cca) {
        console.log(
          `[qa][extract] "${String(u.name)}" status=${String(cca.status)} | ` +
            `text_in_approved=${JSON.stringify(cca.text_in_approved ?? null)} | ` +
            `text_in_live=${JSON.stringify(cca.text_in_live ?? null)}`
        );
      }
    }

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
  function fingerprintParts(i: number): Record<string, unknown> {
    const u = unitContents[i];
    const enh = (u as { aiEnhancements?: AiEnhancement[] | null }).aiEnhancements ?? [];
    const manual = (u as { manualCheckItems?: string[] }).manualCheckItems ?? [];
    const liveImgs = (u as { creativeImages?: FetchedImage[] }).creativeImages ?? [];
    return {
      content: u.content ?? null,
      note: u.note ?? null,
      enh: enh.map((e) => `${e.label}:${e.status}`).sort(),
      manual: [...manual].sort(),
      fmt: (u as { formatInfo?: FormatInfo | null }).formatInfo ?? null,
      liveImgHashes: liveImgs.map((img) => sha1(img.data)).sort(),
      driveImgs: refsPerUnit[i].map((r) => r.name).sort(),
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
    console.log(
      `[qa][fp] unit#${i} "${unitContents[i].name}" adId=${unitContents[i].adId ?? "?"} ` +
        `→ group#${repOfUnit[i]} | fields=${JSON.stringify(fieldHashes)} | ` +
        `nameSig="${p.nameSig}" liveImgs=${(p.liveImgHashes as string[]).length} ` +
        `driveImgs=${JSON.stringify(p.driveImgs)} contentLen=${(unitContents[i].content ?? "").length}`
    );
  }
  console.log(
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
  type Batch = { units: (typeof unitContents); driveImages: FetchedImage[] };
  const batches: Batch[] = repIndices.map((i) => ({
    units: [unitContents[i]],
    driveImages: refsPerUnit[i]
      .map((r) => driveByName.get(r.name))
      .filter((x): x is FetchedImage => !!x),
  }));

  console.log(
    `[qa] ${unitContents.length} ad unit(s) → ${batches.length} unique version(s); running ${batches.length} Claude call(s) (saved ${unitContents.length - batches.length}).`
  );

  // Run per-unit calls concurrently with a cap. Kept deliberately low: each call
  // carries images (token-heavy), so firing 5 at once spiked us past the
  // per-minute input-token limit and threw 429s. At 2 concurrent the token rate
  // stays well under the ceiling, and the hardened retry/backoff below absorbs
  // any remaining bursts. Results stay ordered (written back to their index).
  const MAX_CONCURRENT_BATCHES = 2;

  try {
    const batchResults: Awaited<ReturnType<typeof runBatch>>[] = new Array(batches.length);
    let nextIndex = 0;

    const worker = async (): Promise<void> => {
      while (true) {
        const i = nextIndex++;
        if (i >= batches.length) return;
        const b = batches[i];
        console.log(`[qa] Batch ${i + 1}/${batches.length}: ${b.units.length} unit(s), ${b.driveImages.length} Drive image(s).`);
        batchResults[i] = await runBatch(b.units, b.driveImages);
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
      const safeChecks = hasChecks
        ? base.checks
        : {
            copy_creative_alignment: { status: "unknown", note: "No result returned for this ad — re-run the QA." },
            promo_month_date: { status: "unknown", note: "No result returned." },
            url_cta: { status: "unknown", note: "No result returned." },
            grammar_typos: { status: "unknown", note: "No result returned." },
            ai_enhancements: { status: "unknown", note: "No result returned." },
            format_size: { status: "unknown", note: "No result returned." },
          };
      return {
        ...base,
        checks: safeChecks,
        status: typeof base.status === "string" ? base.status : "warning",
        summary: typeof base.summary === "string" ? base.summary : "",
        name: unitContents[repIdx].name || "Unnamed",
        adId: unitContents[repIdx].adId ?? null,
        group,
        groupSize: group.length,
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
    const message = err instanceof Error ? err.message : String(err);
    console.error("QA API error:", message);
    return NextResponse.json(
      { error: `QA check failed: ${message}` },
      { status: 500 }
    );
  }
}
