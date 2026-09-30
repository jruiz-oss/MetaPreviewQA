// Card-by-card text recovery for creative_alignment.
//
// Why this exists: on big batches (a carousel sends 8 approved + 8 live images in
// one call) the main QA model sometimes skips STEP 1 and returns null for
// text_in_approved / text_in_live while still claiming "all cards match in text"
// (Altura carousel, 2026-09-29). The guard correctly refuses that pass. This
// module recovers a REAL comparison instead: every image is read alone (see
// readImagesWords), the words are joined into per-card transcripts, and a small
// text-only call diffs the two transcript sets.
//
// Principle kept: never assert a defect from missing/unreadable input. If any
// read or the compare call fails, nothing is changed and the guard still
// downgrades the pass to "couldn't verify".
import type Anthropic from "@anthropic-ai/sdk";
import type { ImageRead } from "./onimage-spellcheck";

export type TextCompare = { status: "pass" | "warning" | "fail"; note: string; mismatches: string[] };

// Pure: one image's words → plain text. Prefers the as-rendered token (keeps
// digits/symbols), falls back to the spelled letters.
export function wordsToText(words: unknown[]): string {
  const toks: string[] = [];
  for (const w of words) {
    if (!w || typeof w !== "object") continue;
    const { text, letters } = w as { text?: unknown; letters?: unknown };
    const t =
      typeof text === "string" && text.trim()
        ? text.trim()
        : typeof letters === "string"
        ? letters.replace(/[-\s]/g, "")
        : "";
    if (t) toks.push(t);
  }
  return toks.length ? toks.join(" ") : "no text visible";
}

// Pure: reads → "Card1 (label): ...; Card2 (label): ..." in the same shape the
// main prompt uses for text_in_approved / text_in_live.
export function buildTranscript(reads: ImageRead[]): string {
  return reads.map((r, i) => `Card${i + 1} (${r.label}): ${wordsToText(r.words)}`).join("; ");
}

export const COMPARE_TOOL: Anthropic.Tool = {
  name: "report_text_comparison",
  description: "Report whether the live ad's on-image text matches the approved creative's on-image text.",
  input_schema: {
    type: "object",
    properties: {
      status: { type: "string", enum: ["pass", "warning", "fail"] },
      note: { type: "string", description: "≤25 words, plain language." },
      mismatches: {
        type: "array",
        items: { type: "string" },
        description: "Each concrete difference, e.g. 'Card 2: live says $200, approved says $300'. Empty if none.",
      },
    },
    required: ["status", "note", "mismatches"],
  },
};

export const COMPARE_SYSTEM = `You compare the on-image text of a LIVE Meta ad against its APPROVED creative files. You get two transcripts; each card was read on its own by a proofreader. You do not see the images.

How to compare:
- Cards can be in a different order, and the approved set can hold the same design in several sizes (e.g. 1080x1080 and 1080x1920). Match each live card to the approved card with the same message.
- Ignore line breaks, word order within a card, capitalization, punctuation, and stray fragments from logos or tiny fine print.

Status:
- "fail": a concrete contradiction. A different number, price, rate, date, or offer; a disclaimer present on one side and missing on the other; a word spelled differently; or live text that appears on no approved card.
- "warning": you can't confidently match cards, the transcripts are too sparse to judge, or an approved card's message doesn't appear on any live card.
- "pass": every live card's meaningful text (headline, offer, amounts, dates, disclaimers, CTA) matches an approved card, with no contradiction.
Never invent a difference that isn't in the transcripts.`;

// Text-only compare call. Never throws: returns null when it couldn't run.
export async function compareTranscripts(
  client: Anthropic,
  model: string,
  approved: string,
  live: string,
  log: (msg: string) => void,
  opts: { crossFormat?: boolean } = {}
): Promise<TextCompare | null> {
  const cross = opts.crossFormat
    ? "\nNOTE: the approved files are a different format than the live ad (carousel vs static/story). Compare offer details, dates, and text only; card count differences are not defects."
    : "";
  try {
    const msg = await client.messages.create({
      model,
      max_tokens: 1500,
      system: COMPARE_SYSTEM,
      tools: [COMPARE_TOOL],
      tool_choice: { type: "tool", name: COMPARE_TOOL.name },
      messages: [
        {
          role: "user",
          content: `APPROVED CREATIVE TEXT:\n${approved}\n\nLIVE AD TEXT:\n${live}${cross}`,
        },
      ],
    });
    const tool = msg.content.find((b) => b.type === "tool_use");
    const input = (tool && tool.type === "tool_use" ? tool.input : null) as Partial<TextCompare> | null;
    if (!input || !["pass", "warning", "fail"].includes(String(input.status))) return null;
    return {
      status: input.status as TextCompare["status"],
      note: typeof input.note === "string" ? input.note.trim() : "",
      mismatches: Array.isArray(input.mismatches) ? input.mismatches.filter((m) => typeof m === "string") : [],
    };
  } catch (err) {
    log(`[qa][textcmp] compare call failed (couldn't verify): ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }
}

// Pure: fold a recovered comparison into creative_alignment. The model's
// imagery/layout verdict is kept only when the text also passes; otherwise the
// model's "matches in text" claim is replaced, since it was never checked.
export function applyTextRecovery(
  cca: Record<string, unknown>,
  approved: string,
  live: string,
  cmp: TextCompare
): Record<string, unknown> {
  const out: Record<string, unknown> = { ...cca, text_in_approved: approved, text_in_live: live };
  const prev = typeof cca.note === "string" ? cca.note.trim() : "";
  if (cmp.status === "pass") {
    out.note = `${prev ? `${prev} ` : ""}(On-image text verified card by card.)`.trim();
    return out;
  }
  const detail = cmp.mismatches.length ? ` ${cmp.mismatches.slice(0, 3).join("; ")}` : "";
  out.status = cmp.status;
  out.note = `Card-by-card text check: ${cmp.note || (cmp.status === "fail" ? "text differs from approved." : "couldn't confirm text match.")}${detail}`.trim();
  return out;
}
