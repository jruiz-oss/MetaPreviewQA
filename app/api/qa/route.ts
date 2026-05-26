import { NextResponse } from "next/server";
import Anthropic from "@anthropic-ai/sdk";
import { resolveAdId, fetchAdContent } from "@/lib/meta-api";

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

Review each ad unit on four criteria:
1. copy_creative_alignment — Does the ad copy exactly match the approved copy doc? Does the described creative match the creative spec? Be specific about any differences.
2. promo_month_date — Are any promo months, dates, or time-limited references correct? Flag stale or incorrect date references.
3. url_cta — Does the ad's destination URL match the approved URL exactly? Does the CTA match what was specified?
4. grammar_typos — Any grammar errors, typos, or awkward phrasing?

For each check, assign one of:
- "pass" — looks correct
- "fail" — clear problem found
- "warning" — possible issue or couldn't fully verify

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
        "grammar_typos": { "status": "pass" | "fail" | "warning", "note": "one sentence explanation" }
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

      const { content, error } = await fetchAdContent(adId, accessToken);
      return {
        ...unit,
        content,
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

  // Build the user message
  const unitSections = unitContents
    .map((unit) => {
      const contentBlock = unit.content
        ? `Ad creative content (from Meta API):\n${unit.content}`
        : `Note: ${unit.note ?? "Could not retrieve ad content."} Mark all checks as warning.`;
      const urlLine = unit.link ? `\nURL: ${unit.link}` : "";
      return `---\nAd unit: ${unit.name || "Unnamed"}${urlLine}\n${contentBlock}`;
    })
    .join("\n\n");

  const userMessage = `WORK ORDER SUMMARY:\n${wo}${sourceSections.join("")}\n\nAD UNITS TO REVIEW:\n${unitSections}`;

  try {
    const message = await client.messages.create({
      model: "claude-opus-4-6",
      max_tokens: 4096,
      system: SYSTEM_PROMPT,
      messages: [{ role: "user", content: userMessage }],
    });

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
