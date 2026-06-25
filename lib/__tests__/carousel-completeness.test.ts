/**
 * Regression test for the "carousel vertical cards reported missing" false
 * positive (Restaurants Carousel, ad 120250900702710631).
 *
 * Root cause: the live image pool arrives grouped by size [4×1:1, 4×9:16] and a
 * flat cap of 6 dropped the trailing two 9:16 cards, so the model concluded the
 * vertical versions of cards 3 & 4 were "missing". planQaImages must now keep
 * all 8 (cap=12) and the completeness line must declare full coverage.
 *
 * Run: npx tsx lib/__tests__/carousel-completeness.test.ts
 */
import { planQaImages } from "@/lib/meta-api";
import { computeCompletenessLine } from "@/lib/completeness";

let failures = 0;
function assert(cond: boolean, msg: string) {
  if (cond) {
    console.log(`  ✓ ${msg}`);
  } else {
    console.error(`  ✗ ${msg}`);
    failures++;
  }
}

// The live pool exactly as Meta returns it: 4 squares first, then 4 verticals.
const carouselPool = [
  { url: "sq1", width: 1080, height: 1080 },
  { url: "sq2", width: 1080, height: 1080 },
  { url: "sq3", width: 1080, height: 1080 },
  { url: "sq4", width: 1080, height: 1080 },
  { url: "v1", width: 1080, height: 1920 },
  { url: "v2", width: 1080, height: 1920 },
  { url: "v3", width: 1080, height: 1920 }, // Oak & Fork vertical — was dropped
  { url: "v4", width: 1080, height: 1920 }, // Lucky Ember vertical — was dropped
];

console.log("Scenario 1: 4-card carousel, 4×1:1 + 4×9:16 (the bug case)");
{
  const { ordered, inventory } = planQaImages(carouselPool, true, 4, 12);
  const sent = ordered.slice(0, 12).map((c) => c.url);

  assert(sent.length === 8, "all 8 live assets survive the cap (was 6)");
  assert(sent.includes("v3") && sent.includes("v4"), "both trailing 9:16 cards (v3, v4) are kept");
  assert(inventory.imageCount === 8, "inventory.imageCount = 8");
  assert(inventory.truncated === false, "inventory.truncated = false");
  const vSize = inventory.sizes.find((s) => s.size === "1080x1920");
  assert(vSize?.count === 4, "inventory records 4× 1080x1920 (not 2)");

  // Approved Drive provides both sizes — completeness must declare full coverage.
  const drive = [
    { name: "AKCH-00495 - Caesars - 1080x1080 - v1.jpg" },
    { name: "AKCH-00495 - Caesars - 1080x1920 - v1.jpg" },
    { name: "AKCH-00495 - Oak Fork - 1080x1920 - v1.jpg" },
    { name: "AKCH-00495 - Lucky Ember - 1080x1920 - v1.jpg" },
  ];
  const line = computeCompletenessLine(inventory, drive);
  assert(line.includes("All approved Drive sizes are present"), "completeness line: full coverage, no missing");
  assert(!line.includes("GENUINE GAP"), "completeness line does NOT flag a gap");
}

console.log("Scenario 2: round-robin keeps both sizes even if the cap DOES bite");
{
  // Force truncation with an artificially low cap to prove graceful degradation.
  const { ordered, inventory } = planQaImages(carouselPool, true, 4, 4);
  const sent = ordered.slice(0, 4).map((c) => c.url);
  const squares = sent.filter((u) => u.startsWith("sq")).length;
  const verticals = sent.filter((u) => u.startsWith("v")).length;
  assert(squares === 2 && verticals === 2, "a tight cap keeps a balanced 2+2, not 4 squares + 0 verticals");
  assert(inventory.truncated === true, "inventory.truncated = true when the cap bites");
}

console.log("Scenario 3: a GENUINE gap is still flagged");
{
  // Live ad serves ONLY squares; Drive has a 9:16 the live ad lacks.
  const squaresOnly = carouselPool.filter((c) => c.height === 1080);
  const { inventory } = planQaImages(squaresOnly, true, 4, 12);
  const drive = [
    { name: "AKCH-00495 - Caesars - 1080x1080 - v1.jpg" },
    { name: "AKCH-00495 - Caesars - 1080x1920 - v1.jpg" },
  ];
  const line = computeCompletenessLine(inventory, drive);
  assert(line.includes("GENUINE GAP") && line.includes("1080x1920"), "missing 1080x1920 IS reported as a genuine gap");
}

console.log("Scenario 4: single-image ad keeps the small cap, no carousel reordering");
{
  const singlePool = [
    { url: "s1", width: 1080, height: 1080 },
    { url: "s2", width: 1080, height: 1920 },
  ];
  const { ordered, inventory } = planQaImages(singlePool, false, 0, 6);
  assert(ordered.map((c) => c.url).join(",") === "s1,s2", "single-image order is unchanged");
  assert(inventory.isCarousel === false && inventory.cardCount === 0, "single-image inventory flags non-carousel");
}

if (failures > 0) {
  console.error(`\n${failures} assertion(s) FAILED`);
  process.exit(1);
}
console.log("\nAll assertions passed.");
