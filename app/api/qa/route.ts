import { NextResponse } from "next/server";
import Anthropic from "@anthropic-ai/sdk";
import { google } from "googleapis";
import sharp from "sharp";
import { getOAuthClient } from "@/lib/google-auth";
import { resolveAdId, fetchAdContent, type AiEnhancement, type FormatInfo } from "@/lib/meta-api";

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
  const out: FetchedImage[] = [];
  for (const ref of refs) {
    if (!ref.id || !(ALLOWED_IMAGE_MEDIA_TYPES as string[]).includes(ref.mediaType)) {
      console.log(`[qa] SKIP image "${ref.name}" — unsupported type ${ref.mediaType}.`);
      continue;
    }
    try {
      const res = await drive.files.get(
        { fileId: ref.id, alt: "media", supportsAllDrives: true },
        { responseType: "arraybuffer" }
      );
      const rawBuf = Buffer.from(res.data as ArrayBuffer);
      const { buf, mediaType: resizedType } = await resizeForClaude(rawBuf);
      out.push({ name: ref.name, mediaType: resizedType, data: buf.toString("base64") });
      console.log(`[qa] DOWNLOADED image "${ref.name}" (${(rawBuf.length / 1024).toFixed(0)} KB → ${(buf.length / 1024).toFixed(0)} KB resized) → cross-referenced.`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : "unknown error";
      console.log(`[qa] SKIP image "${ref.name}" — download failed: ${msg}`);
    }
  }
  return out;
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

  const accessToken = process.env.META_ACCESS_TOKEN;
  if (!accessToken) {
    return NextResponse.json(
      { error: "META_ACCESS_TOKEN environment variable is not set." },
      { status: 500 }
    );
  }

  if (!process.env.ANTHROPIC_API_KEY) {
    return NextResponse.json(
      { error: "ANTHROPIC_API_KEY environment variable is not set." },
      { status: 500 }
    );
  }

  // Resolve each unit: extract ad ID → fetch from Meta API
  const unitContents = await Promise.all(
    units.map(async (unit) => {
      const adId = await resolveAdId(unit.link);
      if (!adId) {
        return {
          ...unit,
          content: null,
          note: "Could not extract an ad ID from this URL.",
        };
      }

      const { content, error, aiEnhancements, formatInfo, creativeImageUrls, manualCheckItems } = await fetchAdContent(adId, accessToken);

      // Download live Meta images server-side so we can pass them as base64
      // (Meta CDN URLs are blocked by robots.txt when passed directly to Claude).
      const creativeImages: FetchedImage[] = (
        await Promise.all((creativeImageUrls ?? []).map(downloadUrlImage))
      ).filter((img): img is FetchedImage => img !== null);

      return {
        ...unit,
        content,
        aiEnhancements,
        formatInfo,
        creativeImageUrls,
        creativeImages,
        manualCheckItems,
        note: content ? null : (error ?? "Meta API returned no content."),
      };
    })
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
  type ContentBlock =
    | { type: "text"; text: string }
    | { type: "image"; source: { type: "url"; url: string } }
    | { type: "image"; source: { type: "base64"; media_type: ImageMediaType; data: string } };

  // Download Drive images server-side
  const validDriveImages = await downloadDriveImages(driveImages ?? []);

  // --- Batching helpers ---
  // Max images per API call. Each base64 image averages ~700 KB encoded;
  // keeping ≤12 images per batch stays well under the ~20 MB request limit.
  const MAX_IMAGES_PER_BATCH = 12;

  // Match Drive images to a unit by checking if meaningful words from the
  // unit name appear in the image filename (case-insensitive).
  function driveImagesForUnit(unitName: string): FetchedImage[] {
    if (!validDriveImages.length) return [];
    const words = unitName
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, " ")
      .split(/\s+/)
      .filter((w) => w.length > 3); // skip short stop-words

    if (!words.length) return validDriveImages; // no keywords → include all

    return validDriveImages.filter((img) => {
      const fname = img.name.toLowerCase();
      return words.some((w) => fname.includes(w));
    });
  }

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

    messageContent.push({ type: "text", text: woSection });

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

    const message = await client.messages.create({
      model: "claude-sonnet-4-6",
      max_tokens: 16000,
      system: SYSTEM_PROMPT,
      messages: [{ role: "user", content: messageContent }],
    });

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

    return {
      units: parsed.units ?? [],
      critical_issues: parsed.critical_issues ?? [],
      notes: parsed.notes ?? "",
    };
  }

  // --- Build batches ---
  // Group units so each batch stays under MAX_IMAGES_PER_BATCH total images
  // (Drive images for that batch + live Meta images for those units).
  type Batch = { units: (typeof unitContents); driveImages: FetchedImage[] };
  const batches: Batch[] = [];

  let currentBatch: Batch = { units: [], driveImages: [] };
  let currentImageCount = 0;

  for (const unit of unitContents) {
    const unitDrive = driveImagesForUnit(unit.name ?? "");
    const liveCount = ((unit as { creativeImages?: FetchedImage[] }).creativeImages ?? []).length;
    const unitImageCount = unitDrive.length + liveCount;

    // If adding this unit would exceed the limit AND we already have something,
    // flush the current batch first.
    if (currentBatch.units.length > 0 && currentImageCount + unitImageCount > MAX_IMAGES_PER_BATCH) {
      batches.push(currentBatch);
      currentBatch = { units: [], driveImages: [] };
      currentImageCount = 0;
    }

    // Merge this unit's Drive images into the batch (deduplicate by name)
    for (const img of unitDrive) {
      if (!currentBatch.driveImages.find((d) => d.name === img.name)) {
        currentBatch.driveImages.push(img);
      }
    }
    currentBatch.units.push(unit);
    currentImageCount = currentBatch.driveImages.length + liveCount +
      currentBatch.units
        .slice(0, -1)
        .reduce((s, u) => s + (((u as { creativeImages?: FetchedImage[] }).creativeImages ?? []).length), 0);
  }
  if (currentBatch.units.length > 0) batches.push(currentBatch);

  console.log(`[qa] Running ${batches.length} batch(es) for ${unitContents.length} ad unit(s).`);

  try {
    const batchResults = await Promise.all(
      batches.map((b, i) => {
        console.log(`[qa] Batch ${i + 1}: ${b.units.length} unit(s), ${b.driveImages.length} Drive image(s).`);
        return runBatch(b.units, b.driveImages);
      })
    );

    // Merge batch results
    const allUnits = batchResults.flatMap((r) => r.units);
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
