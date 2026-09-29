// Regression test: the QA prompt must keep the on-image spelling rules
// (exact transcription with [sic], and grammar_typos covering live image text).
// Added after a deliberately misspelled "Credit Unions" on an Altura carousel card
// passed because the model autocorrected it during text extraction.
// Run: npx tsx lib/__tests__/onimage-spelling-prompt.test.ts
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const src = readFileSync(join(__dirname, "../../app/api/qa/route.ts"), "utf8");

assert.ok(src.includes("TRANSCRIBE EXACTLY, LETTER BY LETTER"), "extraction must require exact transcription");
assert.ok(src.includes("[sic]"), "extraction must mark misspellings with [sic]");
assert.ok(src.includes("NEVER silently correct"), "extraction must forbid autocorrecting");
assert.ok(src.includes("BOTH the ad copy text AND every word rendered inside the live images"), "grammar_typos must cover live image text");
assert.ok(src.includes("Card1: ...; Card2: ..."), "carousel extraction must be per card");
console.log("onimage-spelling-prompt: ok");
