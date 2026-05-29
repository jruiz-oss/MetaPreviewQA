import { NextResponse } from "next/server";
import { createHash } from "crypto";
import Anthropic from "@anthropic-ai/sdk";
import { google } from "googleapis";
import sharp from "sharp";
import { getOAuthClient } from "@/lib/google-auth";
import { resolveAdId, fetchAdContent, type AiEnhancement, type FormatInfo } from "@/lib/meta-api";

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

Review each ad unit on six criteria:
1. copy_creative_alignment — Does the ad copy exactly match the approved copy doc? You may receive images from two sources:
   - APPROVED CREATIVE FROM DRIVE: the design files the client signed off on (labeled with their filenames). These are what the live ad is supposed to match.
   - LIVE META CREATIVE: the image(s) actually live in the Meta ad, shown per ad unit below.
   When images are provided, visually inspect the creative: check that any text overlaid on the image (headline, offer text, dates, disclaimers) matches the approved copy, verify the visual theme and imagery match the creative spec, and flag anything in the visual that contradicts the brief (wrong colors, missing/wrong logo, wrong offer amount, stale date visible in the image, etc.). When BOTH a Drive approved image and a live Meta image are present, compare them directly and flag any difference between the approved creative and what is live — match Drive assets to ad units by filename/concept and size (e.g. "1080x1920 V2", "Tier Credit Multiplier", "Carousel"). If only one source is present, check what you can. If no images are provided at all, note that visual creative could not be checked. Be specific about any differences.
2. promo_month_date — Are any promo months, dates, or time-limited references correct? Flag stale or incorrect date references.
3. url_cta — Does the ad's destination URL match the approved URL exactly? Does the CTA match what was specified?
4. grammar_typos — Any grammar errors, typos, or awkward phrasing?
5. ai_enhancements — Are any Meta Advantage+ AI enhancements turned ON? You will receive two pieces of data:
   (a) API-checked enhancements: a list of enhancements and their on/off status fetched directly from the Meta API.
   (b) Manual check required: a list of enhancements that cannot be read from the API and must be verified by a human inside Meta Ads Manager.
   Evaluation rules:
   - If any API-checked enhancement is ON: status = "warning", note = name all ON enhancements, then add "Manual check also required in Ads Manager for: [list the manual items]."
   - If all API-checked enhancements are OFF: status = "warning", note = "All API-readable enhancements are off. The following must still be verified manually in Ads Manager: [list the manual items]."
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

BREVITY IS REQUIRED. Every "note" and "summary" field must be a single sentence of 25 words or fewer. Do not list multiple issues in one note — pick the most important one. Do not use numbered lists inside note fields.

IMPORTANT: Respond ONLY with valid JSON. No prose before or after. Use this exact structure:

{
  "overall_status": "pass" | "fail" | "warning",
  "units": [
    {
      "name": "string",
      "status": "pass" | "fail" | "warning",
      "checks": {
        "copy_creative_alignment": { "status": "pass" | "fail" | "warning", "note": "≤25 words" },
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

type FetchedImage = { name: string; mediaType: ImageMediaType; data: string };

// Anthropic allows up to 5MB per image; cap a touch below that.
const MAX_IMAGE_BYTES = 4_500_000;

// Resize an image buffer so its longest side is ≤ MAX_SIDE px.
// Claude can fully read text and visual details at 768px; sending 1080px originals
// is wasteful and expensive (more tokens). JPEG at quality 75 keeps it lean.
const MAX_SIDE = 768;
async function resizeForClaude(buf: Buffer): Promise<{ buf: Buffer; mediaType: ImageMediaType }> {
  try {
    const resized = await sharp(buf)
      .resize(MAX_SIDE, MAX_SIDE, { fit: "inside", withoutEnlargement: true })
      .jpeg({ quality: 75 })
      .toBuffer();
    return { buf: resized, mediaType: "image/jpeg" };
  } catch {
    // If sharp fails (unsupported format etc.) fall back to original
    return { buf, mediaType: "image/jpeg" };
  }
}

// Download a URL-based image server-side, resize, and return as base64.
async function downloadUrlImage(url: string): Promise<FetchedImage | null> {
  try {
    const res = await fetch(url);
    if (!res.ok) {
      console.log(`[qa] SKIP live Meta image — HTTP ${res.status} for ${url}`);
      return null;
    }
    const rawBuf = Buffer.from(await res.arrayBuffer());
    const { buf, mediaType } = await resizeForClaude(rawBuf);
    const name = url.split("/").pop()?.split("?")[0] ?? "meta-creative.jpg";
    console.log(`[qa] DOWNLOADED live Meta image "${name}" (${(rawBuf.length / 1024).toFixed(0)} KB → ${(buf.length / 1024).toFixed(0)} KB resized).`);
    return { name, mediaType, data: buf.toString("base64") };
  } catch (err) {
    const msg = err instanceof Error ? err.message : "unknown error";
    console.log(`[qa] SKIP live Meta image — download failed: ${msg}`);
    return null;
  }
}

// Download the queued Drive images server-side (no Vercel body limit here).
async function downloadDriveImages(refs: DriveImageRef[]): Promise<FetchedImage[]> {
  if (!refs.length) return [];
  const drive = google.drive({ version: "v3", auth: getOAuthClient() });

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
        const { buf, mediaType: resizedType } = await resizeForClaude(rawBuf);
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

    const { content, error, aiEnhancements, formatInfo, creativeImageUrls, manualCheckItems } = await fetchAdContent(adId, metaToken);

    // Download live Meta images server-side so we can pass them as base64
    // (Meta CDN URLs are blocked by robots.txt when passed directly to Claude).
    const creativeImages: FetchedImage[] = (
      await Promise.all((creativeImageUrls ?? []).map(downloadUrlImage))
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

  function rankRefsForUnit(unitName: string): DriveImageRef[] {
    if (!allDriveRefs.length) return [];
    const unitTokens = new Set(tokenize(unitName));
    if (!unitTokens.size) return [];

    const scored = allDriveRefs
      .map((ref, i) => {
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
  const refsPerUnit = unitContents.map((u) => rankRefsForUnit(u.name ?? ""));
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
      const lines = enhancements.map(
        (e) => `  - ${e.label}: ${e.status === "on" ? "ON ⚠️" : "off"}`
      );
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

    if (message.stop_reason === "max_tokens") {
      throw new Error(
        `Response was cut off (too many ad units in batch). Try reviewing fewer campaigns at once.`
      );
    }

    const raw = message.content[0].type === "text" ? message.content[0].text : "";
    const jsonMatch = raw.match(/\{[\s\S]*\}/);
    if (!jsonMatch) throw new Error("No JSON object found in model response");

    let parsed;
    try {
      parsed = JSON.parse(jsonMatch[0]);
    } catch (parseErr) {
      console.error("Raw model response (first 500 chars):", raw.slice(0, 500));
      throw parseErr;
    }

    // Attach the resolved ad ID to each result unit so the report can show a
    // copy/paste-able ID. The model output isn't trusted to echo it — we map by
    // index back to the batch's input units (one unit per batch here), falling
    // back to the first unit's ID for any extra result units the model emits.
    const resultUnits = (parsed.units ?? []).map(
      (u: Record<string, unknown>, idx: number) => ({
        ...u,
        adId: batchUnits[idx]?.adId ?? batchUnits[0]?.adId ?? null,
      })
    );

    return {
      units: resultUnits,
      critical_issues: parsed.critical_issues ?? [],
      notes: parsed.notes ?? "",
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

  // A unit's fingerprint is the JSON of everything that determines its QA
  // outcome. Live creative images are identified by a hash of their actual
  // bytes (not the Meta CDN URL, which carries per-request tokens) so two ads
  // with pixel-identical creative collapse while any visual difference splits.
  function fingerprintForUnit(i: number): string {
    const u = unitContents[i];
    const enh = (u as { aiEnhancements?: AiEnhancement[] | null }).aiEnhancements ?? [];
    const manual = (u as { manualCheckItems?: string[] }).manualCheckItems ?? [];
    const liveImgs = (u as { creativeImages?: FetchedImage[] }).creativeImages ?? [];
    return JSON.stringify({
      content: u.content ?? null,
      note: u.note ?? null,
      enh: enh.map((e) => `${e.label}:${e.status}`).sort(),
      manual: [...manual].sort(),
      fmt: (u as { formatInfo?: FormatInfo | null }).formatInfo ?? null,
      liveImgHashes: liveImgs.map((img) => sha1(img.data)).sort(),
      driveImgs: refsPerUnit[i].map((r) => r.name).sort(),
      nameSig: nameSignature(u.name ?? ""),
    });
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
      return {
        ...base,
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
