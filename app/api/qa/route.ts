import { NextResponse } from "next/server";
import Anthropic from "@anthropic-ai/sdk";
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
1. copy_creative_alignment — Does the ad copy exactly match the approved copy doc? When images are provided, visually inspect the creative: check that any text overlaid on the image (headline, offer text, dates, disclaimers) matches the approved copy, verify the visual theme and imagery match the creative spec, and flag anything in the visual that contradicts the brief (wrong colors, missing/wrong logo, wrong offer amount, stale date visible in the image, etc.). If no images are provided, note that visual creative could not be checked. Be specific about any differences.
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

IMPORTANT: Respond ONLY with valid JSON. No prose before or after. Use this exact structure:

{
  "overall_status": "pass" | "fail" | "warning",
  "units": [
    {
      "name": "string",
      "status": "pass" | "fail" | "warning",
      "checks": {
        "copy_creative_alignment": { "status": "pass" | "fail" | "warning", "note": "one sentence explanation" },
        "promo_month_date": { "status": "pass" | "fail" | "warning", "note": "one sentence explanation" },
        "url_cta": { "status": "pass" | "fail" | "warning", "note": "one sentence explanation" },
        "grammar_typos": { "status": "pass" | "fail" | "warning", "note": "one sentence explanation" },
        "ai_enhancements": { "status": "pass" | "warning" | "unknown", "note": "one sentence explanation" },
        "format_size": { "status": "pass" | "fail" | "warning" | "unknown", "note": "one sentence explanation" }
      },
      "summary": "one sentence overall summary for this unit"
    }
  ],
  "critical_issues": ["list only the most urgent problems — keep empty if none"],
  "notes": "optional top-level note, or empty string"
}`;

type AdUnit = {
  name: string;
  link: string;
};

type LabeledDoc = {
  label: string;
  content: string;
};

export async function POST(request: Request) {
  const { wo, units, labeledDocs, destinationUrl } = (await request.json()) as {
    wo: string;
    units: AdUnit[];
    labeledDocs?: LabeledDoc[];
    destinationUrl?: string | null;
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

      const { content, error, aiEnhancements, formatInfo, creativeImageUrls } = await fetchAdContent(adId, accessToken);
      return {
        ...unit,
        content,
        aiEnhancements,
        formatInfo,
        creativeImageUrls,
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

  // Build the user message — multi-modal: text + image blocks per unit
  type ContentBlock =
    | { type: "text"; text: string }
    | { type: "image"; source: { type: "url"; url: string } };

  const messageContent: ContentBlock[] = [];

  // Opening text: WO + source docs
  messageContent.push({
    type: "text",
    text: `WORK ORDER SUMMARY:\n${wo}${sourceSections.join("")}\n\nAD UNITS TO REVIEW:`,
  });

  for (const unit of unitContents) {
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

    // Image URLs for visual QA
    const imageUrls = (unit as { creativeImageUrls?: string[] }).creativeImageUrls ?? [];
    const imageNote = imageUrls.length > 0
      ? `\nCreative images: ${imageUrls.length} image(s) follow below for visual review.`
      : "\nCreative images: not available — visual creative check cannot be performed.";

    messageContent.push({
      type: "text",
      text: `\n---\nAd unit: ${unit.name || "Unnamed"}${urlLine}\n${contentBlock}${enhancementsBlock}${formatBlock}${imageNote}`,
    });

    // Append actual image blocks for this unit
    for (const imgUrl of imageUrls) {
      messageContent.push({
        type: "image",
        source: { type: "url", url: imgUrl },
      });
    }
  }

  try {
    const message = await client.messages.create({
      model: "claude-opus-4-6",
      max_tokens: 16000,
      system: SYSTEM_PROMPT,
      messages: [{ role: "user", content: messageContent }],
    });

    // Catch truncation before attempting to parse
    if (message.stop_reason === "max_tokens") {
      console.error("Response truncated — too many ad units for a single request. Consider reviewing fewer campaigns at once.");
      throw new Error(
        `Response was cut off (too many ad units). Try reviewing fewer campaigns at once (${units.length} units submitted).`
      );
    }

    const raw =
      message.content[0].type === "text" ? message.content[0].text : "";

    // Extract JSON robustly — handles markdown fences, leading/trailing text
    const jsonMatch = raw.match(/\{[\s\S]*\}/);
    if (!jsonMatch) throw new Error("No JSON object found in model response");

    let result;
    try {
      result = JSON.parse(jsonMatch[0]);
    } catch (parseErr) {
      console.error("Raw model response (first 500 chars):", raw.slice(0, 500));
      console.error("Stop reason:", message.stop_reason);
      throw parseErr;
    }

    return NextResponse.json(result);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("QA API error:", message);
    return NextResponse.json(
      { error: `QA check failed: ${message}` },
      { status: 500 }
    );
  }
}
