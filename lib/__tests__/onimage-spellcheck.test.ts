// Run: npx tsx lib/__tests__/onimage-spellcheck.test.ts
import assert from "node:assert/strict";
import { extractSpellFindings, applySpellFindings, formatSpellNote } from "../onimage-spellcheck";

// The Altura case: card 2 says "Crdit" — must become a finding.
{
  const f = extractSpellFindings("2/8 (Carousel card 2)", {
    words: [
      { letters: "F-O-R-B-E-S", is_correct: true },
      { letters: "C-R-D-I-T", is_correct: false, expected: "Credit" },
      { letters: "U-N-I-O-N-S", is_correct: true },
    ],
  });
  assert.equal(f.length, 1);
  assert.equal(f[0].written, "CRDIT");
  assert.equal(f[0].expected, "Credit");
}

// Noise is ignored: malformed input, fragments, self-contradicting "misspellings", duplicates.
assert.deepEqual(extractSpellFindings("x", null), []);
assert.deepEqual(extractSpellFindings("x", { words: "nope" }), []);
assert.deepEqual(extractSpellFindings("x", { words: [{ letters: "A-B", is_correct: false }] }), []);
assert.deepEqual(extractSpellFindings("x", { words: [{ letters: "C-R-E-D-I-T", is_correct: false, expected: "credit" }] }), []);
assert.equal(
  extractSpellFindings("x", { words: [
    { letters: "C-R-D-I-T", is_correct: false, expected: "Credit" },
    { letters: "C-R-D-I-T", is_correct: false, expected: "Credit" },
  ] }).length,
  1
);
// Correct words never produce findings.
assert.deepEqual(extractSpellFindings("x", { words: [{ letters: "C-R-E-D-I-T", is_correct: true }] }), []);

// Merge: no findings leaves the check untouched.
const orig = { status: "pass", note: "No errors." };
assert.equal(applySpellFindings(orig, []), orig);

// Merge: a finding overrides a pass and replaces the contradicting note.
{
  const r = applySpellFindings(orig, [{ image: "card 2", written: "CRDIT", expected: "Credit" }])!;
  assert.equal(r.status, "fail");
  assert.match(String(r.note), /CRDIT/);
  assert.doesNotMatch(String(r.note), /No errors/);
}

// Merge: an existing fail note is kept and appended to.
{
  const r = applySpellFindings({ status: "fail", note: "Typo in headline." }, [{ image: "a", written: "Unoin" }])!;
  assert.equal(r.status, "fail");
  assert.match(String(r.note), /^Typo in headline\.; Misspelled on-image text/);
}

// Note is capped.
assert.match(
  formatSpellNote(Array.from({ length: 6 }, (_, i) => ({ image: "i", written: `Wrd${i}` }))),
  /\+2 more$/
);
console.log("onimage-spellcheck: ok");
