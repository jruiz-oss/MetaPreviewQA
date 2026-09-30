// Dedicated per-image spelling pass for text rendered INSIDE live creative.
//
// Why this exists: the main QA call reads 10-16 images at once and summarizes
// their text while comparing it to the approved files. In that setting the model
// silently autocorrects small typos ("Crdit" -> "Credit") during transcription, so
// a deliberately misspelled card passed twice (Altura carousel, 2026-09-29).
// Here ONE image is read per call, and the model must spell each word out letter
// by letter BEFORE judging it, which is what stops the autocorrect. The verdict is
// then computed from those letters in code, not trusted from a summary.
//
// Principle kept from the rest of the codebase: never assert a defect from
// missing/unreadable input. A failed call or an unreadable image yields NO
// finding (logged), never a fabricated one.
import type Anthropic from "@anthropic-ai/sdk";
import { createHash } from "node:crypto";

export type SpellImage = {
  name: string;
  mediaType: "image/jpeg" | "image/png" | "image/gif" | "image/webp";
  data: string;
  context?: string | null;
};

export type SpellFinding = {
  image: string; // label of the image the word was found on
  written: string; // the word exactly as rendered in the pixels
  expected?: string; // the correct spelling, when the model is confident
};

export const SPELLCHECK_TOOL: Anthropic.Tool = {
  name: "report_image_words",
  description: "Report every word of text rendered in the image, spelled out letter by letter.",
  input_schema: {
    type: "object",
    properties: {
      words: {
        type: "array",
        description: "Every word of legible text in the image, in reading order.",
        items: {
          type: "object",
          properties: {
            text: {
              type: "string",
              description:
                "The token exactly as rendered, including digits and symbols (e.g. $300, 12/31/2026, 4.25%, Credit). Never correct it.",
            },
            letters: {
              type: "string",
              description:
                "The word spelled out letter by letter, exactly as the pixels show it, e.g. C-R-E-D-I-T. Never correct it.",
            },
            is_correct: {
              type: "boolean",
              description:
                "Judge ONLY the letters you just wrote: false if they do not form a correctly spelled word (or a correctly spelled known brand/product name).",
            },
            expected: {
              type: "string",
              description: "If is_correct is false, the correct spelling. Otherwise empty.",
            },
          },
          required: ["letters", "is_correct"],
        },
      },
    },
    required: ["words"],
  },
};

export const SPELLCHECK_SYSTEM = `You are a proofreader reading ONE ad image. Your only job is to catch spelling mistakes in the text rendered inside the image.

Method:
1. Find every piece of legible text in the image, including headlines, badges, buttons, logos, fine print, and signage.
2. For each word, write out its letters exactly as the pixels show them, one letter at a time (C-R-E-D-I-T). Do this from the pixels, not from what the word should be. Autocorrecting is the failure you exist to prevent: if the image says "Crdit", you write C-R-D-I-T.
3. Only then judge each word from the letters you wrote. is_correct=false means those exact letters are not a correctly spelled word.

Rules:
- Include numbers, prices, rates, and dates as their own entries too (text="$300", letters="3-0-0", is_correct=true) so the full text of the image is captured. Never mark a number as misspelled.
- Judge spelling only. Ignore capitalization style (ALL CAPS is fine), punctuation, spacing, and line breaks.
- Proper nouns and brand names are correct unless the letters clearly differ from a spelling you know (e.g. "Statista" is correct; a brand you do not recognize is correct).
- Skip text too small, blurry, or cut off to read with confidence. Never guess at unreadable text and never report a word you cannot actually see.
- Do not comment on design, layout, or content. If there is no legible text, return an empty words array.`;

// Pure: turn the tool input into findings. Anything malformed is ignored.
export function extractSpellFindings(imageLabel: string, toolInput: unknown): SpellFinding[] {
  const words = (toolInput as { words?: unknown } | null)?.words;
  if (!Array.isArray(words)) return [];
  const out: SpellFinding[] = [];
  const seen = new Set<string>();
  for (const w of words) {
    if (!w || typeof w !== "object") continue;
    const { letters, is_correct, expected } = w as { letters?: unknown; is_correct?: unknown; expected?: unknown };
    if (is_correct !== false || typeof letters !== "string") continue;
    const written = letters.replace(/[^A-Za-z'’]/g, "");
    if (written.length < 3) continue; // fragments/noise are not findings
    const exp = typeof expected === "string" ? expected.trim() : "";
    // A "misspelling" whose expected form is identical to what was written is the
    // model contradicting itself — not a finding.
    if (exp && exp.toLowerCase() === written.toLowerCase()) continue;
    const key = written.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ image: imageLabel, written, expected: exp || undefined });
  }
  return out;
}

const MAX_NOTE_FINDINGS = 4;

// Pure: a short human note for the grammar_typos check.
export function formatSpellNote(findings: SpellFinding[]): string {
  const shown = findings.slice(0, MAX_NOTE_FINDINGS).map((f) => {
    const fix = f.expected ? ` (should be "${f.expected}")` : "";
    return `"${f.written}"${fix} in live image ${f.image}`;
  });
  const more = findings.length > MAX_NOTE_FINDINGS ? `; +${findings.length - MAX_NOTE_FINDINGS} more` : "";
  return `Misspelled on-image text: ${shown.join("; ")}${more}`;
}

// Pure: fold findings into a unit's grammar_typos check. No findings -> untouched.
export function applySpellFindings(
  check: Record<string, unknown> | undefined,
  findings: SpellFinding[]
): Record<string, unknown> | undefined {
  if (findings.length === 0) return check;
  const note = formatSpellNote(findings);
  const prev = check && typeof check.note === "string" ? check.note.trim() : "";
  const prevStatus = check?.status;
  // A prior "pass"/"unknown" note ("No errors") would contradict the finding, so
  // it is replaced; an existing fail/warning note is kept and appended to.
  const keepPrev = prev && (prevStatus === "fail" || prevStatus === "warning");
  return { ...(check ?? {}), status: "fail", note: keepPrev ? `${prev}; ${note}` : note };
}

export type ImageRead = { label: string; ok: boolean; words: unknown[] };

type ReadCache = Map<string, Promise<{ ok: boolean; words: unknown[] }>>;

async function readOneImage(
  client: Anthropic,
  model: string,
  img: SpellImage
): Promise<{ ok: boolean; words: unknown[] }> {
  try {
    const msg = await client.messages.create({
      model,
      max_tokens: 3000,
      system: SPELLCHECK_SYSTEM,
      tools: [SPELLCHECK_TOOL],
      tool_choice: { type: "tool", name: SPELLCHECK_TOOL.name },
      messages: [
        {
          role: "user",
          content: [
            { type: "image", source: { type: "base64", media_type: img.mediaType, data: img.data } },
            { type: "text", text: "Spell out every word of text in this image letter by letter, then judge each one." },
          ],
        },
      ],
    });
    const tool = msg.content.find((b) => b.type === "tool_use");
    const words = tool && tool.type === "tool_use" ? (tool.input as { words?: unknown })?.words : undefined;
    if (!Array.isArray(words)) return { ok: false, words: [] };
    return { ok: true, words };
  } catch {
    return { ok: false, words: [] };
  }
}

// Reads every image ALONE (one call each) with bounded concurrency. Never throws.
// A shared cache (keyed by image bytes) lets the text-recovery pass and the
// spelling pass reuse the same read of a live image instead of paying twice.
export async function readImagesWords(
  client: Anthropic,
  model: string,
  images: SpellImage[],
  log: (msg: string) => void,
  opts: { concurrency?: number; maxImages?: number; cache?: ReadCache; tag?: string } = {}
): Promise<ImageRead[]> {
  const list = images.slice(0, opts.maxImages ?? 12);
  const results: ImageRead[] = new Array(list.length);
  let next = 0;
  const worker = async () => {
    while (true) {
      const i = next++;
      if (i >= list.length) return;
      const img = list[i];
      const label = `${i + 1}/${list.length} (${img.context || img.name})`;
      const key = createHash("sha1").update(img.data).digest("hex");
      let p = opts.cache?.get(key);
      const cached = !!p;
      if (!p) {
        p = readOneImage(client, model, img);
        opts.cache?.set(key, p);
      }
      const r = await p;
      results[i] = { label, ok: r.ok, words: r.words };
      if (opts.tag) {
        log(
          `[qa][${opts.tag}] image ${label}: ` +
            (r.ok ? `${r.words.length} word(s) read${cached ? " (cached)" : ""}` : "read failed (couldn't verify)")
        );
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(opts.concurrency ?? 4, list.length) }, () => worker()));
  return results;
}

// Runs the per-image spelling pass. Never throws: a failed image is logged and
// skipped so it can never become a fabricated defect.
export async function spellCheckImages(
  client: Anthropic,
  model: string,
  images: SpellImage[],
  log: (msg: string) => void,
  opts: { concurrency?: number; maxImages?: number; cache?: ReadCache } = {}
): Promise<SpellFinding[]> {
  const reads = await readImagesWords(client, model, images, log, opts);
  const out: SpellFinding[] = [];
  for (const r of reads) {
    if (!r.ok) {
      log(`[qa][spell] image ${r.label} skipped (couldn't verify)`);
      continue;
    }
    const found = extractSpellFindings(r.label, { words: r.words });
    log(
      `[qa][spell] image ${r.label}: ${r.words.length} word(s) read, ${found.length} misspelled` +
        (found.length ? ` → ${found.map((f) => `${f.written}${f.expected ? `→${f.expected}` : ""}`).join(", ")}` : "")
    );
    out.push(...found);
  }
  return out;
}
