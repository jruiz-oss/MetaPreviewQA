import { NextResponse } from "next/server";
import Anthropic from "@anthropic-ai/sdk";
import { resolveAdId, fetchAdContent } from "@/lib/meta-api";

const client = new Anthropic();

const SYSTEM_PROMPT = `You are a QA reviewer for social media ads at a digital marketing agency. Your job is to check each ad unit against the work order provided.

For each ad unit you will receive:
- The ad unit name and preview link URL
- The ad creative content pulled directly from the Meta API (copy, headline, CTA, destination URL)

Review each ad unit against the work order on four criteria:
1. copy_creative_alignment — Does the copy and described creative match what the WO specifies? Look for mismatched imagery descriptions, wrong product/offer references, wrong campaign theme.
2. promo_month_date — Are any promo months, dates, or time-limited references correct per the WO? Flag if last month's promo language appears.
3. url_cta — Does the CTA or destination URL match what the WO specifies?
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

export async function POST(request: Request) {
  const { wo, units } = (await request.json()) as {
    wo: string;
    units: AdUnit[];
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

  const userMessage = `WORK ORDER:\n${wo}\n\nAD UNITS TO REVIEW:\n${unitSections}`;

  try {
    const message = await client.messages.create({
      model: "claude-opus-4-6",
      max_tokens: 2048,
      system: SYSTEM_PROMPT,
      messages: [{ role: "user", content: userMessage }],
    });

    const raw =
      message.content[0].type === "text" ? message.content[0].text : "";

    const cleaned = raw
      .replace(/^```json\s*/i, "")
      .replace(/```\s*$/i, "")
      .trim();
    const result = JSON.parse(cleaned);

    return NextResponse.json(result);
  } catch (err) {
    console.error("QA API error:", err);
    return NextResponse.json(
      { error: "QA check failed. Check your API key and try again." },
      { status: 500 }
    );
  }
}
