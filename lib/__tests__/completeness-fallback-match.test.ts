/**
 * Regression test for FIX #16: fallback-matched Drive refs must not assert a
 * GENUINE GAP.
 *
 * When rankRefsForUnit routes assets via the zero-token fallback (whole
 * eligible pool attached) or the cross-format gate, the attached files may
 * belong to a different concept or format than this unit. Their filename size
 * tokens are therefore NOT this unit's required live sizes — a size they carry
 * that the live ad doesn't serve must degrade to couldn't-verify, never
 * "GENUINE GAP; flag this".
 *
 * Run: npx tsx lib/__tests__/completeness-fallback-match.test.ts
 */
import { computeCompletenessLine } from "@/lib/completeness";
import type { CreativeInventory } from "@/lib/meta-api";

let failures = 0;
function assert(cond: boolean, msg: string) {
  if (cond) console.log(`  ✓ ${msg}`);
  else { console.error(`  ✗ ${msg}`); failures++; }
}

// Live carousel serving only 1080x1080 cards; fallback attached a cross-format
// static story file (1080x1920) from the shared folder.
const inv: CreativeInventory = {
  isCarousel: true,
  cardCount: 4,
  imageCount: 4,
  sizes: [{ size: "1080x1080", count: 4 }],
  imagesSentForVisualQa: 4,
  truncated: false,
};
const drive = [
  { name: "Concept A - Static 1080x1080.jpg" },
  { name: "Concept A - Static 1080x1920.jpg" },
];

console.log("Scenario 1: fallback match (confidentMatch=false) — no GENUINE GAP");
{
  const line = computeCompletenessLine(inv, drive, false);
  assert(!line.includes("GENUINE GAP"), "does NOT assert a GENUINE GAP from fallback-matched refs");
  assert(line.includes("fallback-matched"), "explains the refs were fallback-matched");
  assert(line.includes("1080x1920"), "names the unverified size for context");
  assert(line.toLowerCase().includes("do not report these sizes as missing"), "instructs the model not to flag");
}

console.log("Scenario 2: confident match (confidentMatch=true) — real gap still fires (no regression)");
{
  const line = computeCompletenessLine(inv, drive, true);
  assert(line.includes("GENUINE GAP"), "still flags a real gap on a confident match");
  assert(line.includes("1080x1920"), "names the genuinely missing size");
}

console.log("Scenario 3: default arg preserves old behavior (no regression for callers omitting the flag)");
{
  const line = computeCompletenessLine(inv, drive);
  assert(line.includes("GENUINE GAP"), "omitted flag defaults to confident (gap fires)");
}

console.log("Scenario 4: fallback match with FULL coverage — pass message unaffected");
{
  const covered: CreativeInventory = {
    ...inv,
    sizes: [
      { size: "1080x1080", count: 4 },
      { size: "1080x1920", count: 4 },
    ],
  };
  const line = computeCompletenessLine(covered, drive, false);
  assert(!line.includes("GENUINE GAP"), "no gap when all sizes covered");
  assert(line.includes("All approved Drive sizes are present"), "full-coverage message still emitted");
}

console.log("Scenario 5: fallback + unknown dims — still degrades, never asserts");
{
  const partial: CreativeInventory = {
    ...inv,
    sizes: [
      { size: "1080x1080", count: 3 },
      { size: "unknown", count: 1 },
    ],
  };
  const line = computeCompletenessLine(partial, drive, false);
  assert(!line.includes("GENUINE GAP"), "no gap with fallback refs + unreadable dims");
}

if (failures) { console.error(`\n${failures} assertion(s) FAILED`); process.exit(1); }
console.log("\nAll assertions passed.");
