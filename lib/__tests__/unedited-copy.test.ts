// Regression test for the duplicated-campaign "unedited copy" heuristic.
// Run: npx tsx lib/__tests__/unedited-copy.test.ts
//
// Workflow this protects: the team duplicates a campaign (copies land paused,
// with fresh created/updated_time), then swaps each copy's creative and runs
// it. A copy that has NOT been swapped yet still carries the previous promo's
// creative and must be flaggable; a swapped one (updated_time moved) must not.
import assert from "node:assert/strict";
import { isUneditedCopy } from "../meta-api";

const t0 = "2026-09-01T10:00:00+0000";
const plus = (ms: number) => new Date(Date.parse(t0) + ms).toISOString();

// Copied, never touched → unedited.
assert.equal(isUneditedCopy("123", t0, t0), true);
assert.equal(isUneditedCopy("123", t0, plus(30_000)), true, "30s after copy still counts as untouched");
assert.equal(isUneditedCopy("123", t0, plus(9 * 60_000)), true, "just inside the 10-minute window");

// Copied, then edited (creative swapped) → not unedited.
assert.equal(isUneditedCopy("123", t0, plus(11 * 60_000)), false, "edited 11 minutes later");
assert.equal(isUneditedCopy("123", t0, plus(3 * 24 * 3_600_000)), false, "edited days later");

// Not a copy at all → never flagged, regardless of timestamps.
assert.equal(isUneditedCopy(null, t0, t0), false);
assert.equal(isUneditedCopy("", t0, t0), false);

// Unparseable timestamps degrade to "not flagged" — never assert from bad input.
assert.equal(isUneditedCopy("123", "", ""), false);
assert.equal(isUneditedCopy("123", t0, "not-a-date"), false);

console.log("unedited-copy.test.ts: all assertions passed");
