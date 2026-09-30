// Run: npx tsx lib/__tests__/card-text-compare.test.ts
import assert from "node:assert/strict";
import { wordsToText, buildTranscript, applyTextRecovery } from "../card-text-compare";

// Keeps digits/symbols via `text`, falls back to spelled letters.
assert.equal(
  wordsToText([{ text: "$300", letters: "3-0-0" }, { letters: "C-R-E-D-I-T" }, null, { letters: "" }]),
  "$300 CREDIT"
);
assert.equal(wordsToText([]), "no text visible");

assert.equal(
  buildTranscript([
    { label: "1/2 (a)", ok: true, words: [{ text: "Free" }] },
    { label: "2/2 (b)", ok: true, words: [] },
  ]),
  "Card1 (1/2 (a)): Free; Card2 (2/2 (b)): no text visible"
);

const cca = { status: "pass", note: "All cards match.", text_in_approved: null, text_in_live: null };
// Pass keeps the model verdict, fills text, marks as verified.
{
  const r = applyTextRecovery(cca, "A", "L", { status: "pass", note: "ok", mismatches: [] });
  assert.equal(r.status, "pass");
  assert.equal(r.text_in_approved, "A");
  assert.equal(r.text_in_live, "L");
  assert.match(String(r.note), /verified card by card/);
}
// Fail replaces the unverified "match" claim.
{
  const r = applyTextRecovery(cca, "A", "L", { status: "fail", note: "Offer differs.", mismatches: ["Card 2: $200 vs $300"] });
  assert.equal(r.status, "fail");
  assert.doesNotMatch(String(r.note), /All cards match/);
  assert.match(String(r.note), /\$200 vs \$300/);
}
console.log("card-text-compare tests passed");
