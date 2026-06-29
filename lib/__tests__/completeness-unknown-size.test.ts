/**
 * Regression test for FIX #1: false "size missing / GENUINE GAP" when the Meta
 * API returns no readable width/height for the live image assets.
 *
 * Root cause: when every live size is "unknown", liveSizeSet was empty, so EVERY
 * approved Drive size was reported as a GENUINE GAP — a false positive, since the
 * ad IS serving those sizes; we just couldn't read the dimensions. The fix
 * degrades to "couldn't compute coverage" instead of asserting a gap.
 *
 * Run: npx tsx lib/__tests__/completeness-unknown-size.test.ts
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

console.log("Scenario 1: live assets exist but Meta returned NO dimensions (all unknown)");
{
  const inv: CreativeInventory = {
    isCarousel: false,
    cardCount: 0,
    imageCount: 2,
    sizes: [{ size: "unknown", count: 2 }],
    imagesSentForVisualQa: 2,
    truncated: false,
  };
  const line = computeCompletenessLine(inv, drive);
  assert(!line.includes("GENUINE GAP"), "does NOT falsely flag a gap when sizes are unreadable");
  assert(line.includes("could NOT be computed") || line.includes("could not be read"),
    "explains coverage couldn't be computed");
}

console.log("Scenario 2: a real gap is STILL flagged when live sizes ARE known");
{
  const inv: CreativeInventory = {
    isCarousel: false,
    cardCount: 0,
    imageCount: 1,
    sizes: [{ size: "1080x1080", count: 1 }], // serves square only
    imagesSentForVisualQa: 1,
    truncated: false,
  };
  const line = computeCompletenessLine(inv, drive); // drive also has 1080x1920
  assert(line.includes("GENUINE GAP"), "still flags a genuine gap (1080x1920 missing live)");
  assert(line.includes("1080x1920"), "names the missing size");
}

console.log("Scenario 3: full coverage when known live sizes cover all approved sizes");
{
  const inv: CreativeInventory = {
    isCarousel: false,
    cardCount: 0,
    imageCount: 2,
    sizes: [{ size: "1080x1080", count: 1 }, { size: "1080x1920", count: 1 }],
    imagesSentForVisualQa: 2,
    truncated: false,
  };
  const line = computeCompletenessLine(inv, drive);
  assert(line.includes("All approved Drive sizes are present"), "reports full coverage, no gap");
  assert(!line.includes("GENUINE GAP"), "no gap flagged");
}

if (failures) {
  console.error(`\n${failures} assertion(s) FAILED.`);
  process.exit(1);
}
console.log("\nAll assertions passed.");
