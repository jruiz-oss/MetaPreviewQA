/**
 * Regression test for FIX #12: false GENUINE GAP when only SOME live assets
 * have unreadable dimensions.
 *
 * FIX #1 handled the all-unknown case, but a PARTIAL read had the same failure
 * mode one case narrower: if the 1080x1080 is readable and the 1080x1920 is
 * not, liveSizeSet was non-empty, so the 1080x1920 was asserted as a GENUINE
 * GAP even though it may be one of the unreadable assets. Any unknown-dim
 * asset means the live size set is incomplete → degrade to couldn't-verify.
 *
 * Run: npx tsx lib/__tests__/completeness-partial-unknown.test.ts
 */
import { computeCompletenessLine } from "@/lib/completeness";
import type { CreativeInventory } from "@/lib/meta-api";

let failures = 0;
function assert(cond: boolean, msg: string) {
  if (cond) console.log(`  ✓ ${msg}`);
  else { console.error(`  ✗ ${msg}`); failures++; }
}

const drive = [
  { name: "Promo - 1080x1080 - v1.jpg" },
  { name: "Promo - 1080x1920 - v1.jpg" },
];

console.log("Scenario 1: one size readable, one asset with unknown dims — approved size not among known sizes");
{
  const inv: CreativeInventory = {
    isCarousel: false,
    cardCount: 0,
    imageCount: 2,
    sizes: [
      { size: "1080x1080", count: 1 },
      { size: "unknown", count: 1 },
    ],
    imagesSentForVisualQa: 2,
    truncated: false,
  };
  const line = computeCompletenessLine(inv, drive);
  assert(!line.includes("GENUINE GAP"), "does NOT assert a GENUINE GAP when unknown-dim assets exist");
  assert(line.includes("unreadable dimensions"), "explains that unreadable dims prevent verification");
  assert(line.includes("1080x1920"), "names the unconfirmed size for context");
}

console.log("Scenario 2: all dims readable, size truly missing — gap still fires (no regression)");
{
  const inv: CreativeInventory = {
    isCarousel: false,
    cardCount: 0,
    imageCount: 1,
    sizes: [{ size: "1080x1080", count: 1 }],
    imagesSentForVisualQa: 1,
    truncated: false,
  };
  const line = computeCompletenessLine(inv, drive);
  assert(line.includes("GENUINE GAP"), "still flags a real gap when every live dim was readable");
  assert(line.includes("1080x1920"), "names the genuinely missing size");
}

console.log("Scenario 3: all dims readable, full coverage — pass message (no regression)");
{
  const inv: CreativeInventory = {
    isCarousel: false,
    cardCount: 0,
    imageCount: 2,
    sizes: [
      { size: "1080x1080", count: 1 },
      { size: "1080x1920", count: 1 },
    ],
    imagesSentForVisualQa: 2,
    truncated: false,
  };
  const line = computeCompletenessLine(inv, drive);
  assert(!line.includes("GENUINE GAP"), "no gap when all sizes are covered");
  assert(line.includes("All approved Drive sizes are present"), "states full coverage");
}

console.log("Scenario 4 (FIX #14 companion): asset-feed carousel — cardCount 0 must not read as '0 cards'");
{
  const inv: CreativeInventory = {
    isCarousel: true,
    cardCount: 0,
    imageCount: 4,
    sizes: [{ size: "1080x1080", count: 4 }],
    imagesSentForVisualQa: 4,
    truncated: false,
  };
  const line = computeCompletenessLine(inv, []);
  assert(!line.includes("0 configured card"), "never says '0 configured card(s)'");
  assert(line.includes("card count not reported"), "says the card count is unavailable instead");
}

console.log("Scenario 5 (FIX #14 companion): configured carousel — real count still shown");
{
  const inv: CreativeInventory = {
    isCarousel: true,
    cardCount: 5,
    imageCount: 5,
    sizes: [{ size: "1080x1080", count: 5 }],
    imagesSentForVisualQa: 5,
    truncated: false,
  };
  const line = computeCompletenessLine(inv, []);
  assert(line.includes("5 configured card(s)"), "reports the configured card count");
}

if (failures) { console.error(`\n${failures} assertion(s) FAILED`); process.exit(1); }
console.log("\nAll assertions passed.");
