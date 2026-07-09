/**
 * Regression test: approved Drive VIDEOS must not create false size gaps.
 *
 * Root cause: Drive videos reach QA as "(Drive thumbnail frame)" images, and
 * their filenames often carry a size token ("… 1080x1920.mp4"). The live
 * inventory's `sizes` counts IMAGE assets only — a live video never contributes
 * a size — so a Drive video's size was reported as "GENUINE GAP — not served
 * live" even when the live ad serves exactly that video. Video refs are now
 * excluded from size coverage and called out as couldn't-verify.
 *
 * Run: npx tsx lib/__tests__/completeness-video-drive.test.ts
 */
import { computeCompletenessLine } from "@/lib/completeness";
import type { CreativeInventory } from "@/lib/meta-api";

let failures = 0;
function assert(cond: boolean, msg: string) {
  if (cond) console.log(`  ✓ ${msg}`);
  else { console.error(`  ✗ ${msg}`); failures++; }
}

console.log("Scenario 1: Drive has a sized VIDEO the live ad serves as video (no image size)");
{
  const inv: CreativeInventory = {
    isCarousel: false,
    cardCount: 0,
    imageCount: 1,
    sizes: [{ size: "1080x1080", count: 1 }], // live IMAGE inventory: square only
    imagesSentForVisualQa: 1,
    truncated: false,
  };
  const drive = [
    { name: "Promo - 1080x1080 - v1.jpg" },
    { name: "Promo - Story 1080x1920.mp4 (Drive thumbnail frame)" }, // video — live as video, not image
  ];
  const line = computeCompletenessLine(inv, drive);
  assert(!line.includes("GENUINE GAP"), "video's 1080x1920 is NOT flagged as a gap");
  assert(line.includes("video(s) are excluded"), "explains videos are excluded from size coverage");
}

console.log("Scenario 2: a real IMAGE gap is still flagged alongside a video");
{
  const inv: CreativeInventory = {
    isCarousel: false,
    cardCount: 0,
    imageCount: 1,
    sizes: [{ size: "1080x1080", count: 1 }],
    imagesSentForVisualQa: 1,
    truncated: false,
  };
  const drive = [
    { name: "Promo - 1080x1080 - v1.jpg" },
    { name: "Promo - 1080x1350 - v1.jpg" }, // image size genuinely not served live
    { name: "Promo - Story 1080x1920.mp4 (Drive thumbnail frame)" },
  ];
  const line = computeCompletenessLine(inv, drive);
  assert(line.includes("GENUINE GAP") && line.includes("1080x1350"), "missing IMAGE size 1080x1350 IS still flagged");
  assert(!line.includes("1080x1920"), "video's size does not appear in the gap list");
}

console.log("Scenario 3: image-only Drive set behaves exactly as before");
{
  const inv: CreativeInventory = {
    isCarousel: false,
    cardCount: 0,
    imageCount: 2,
    sizes: [{ size: "1080x1080", count: 1 }, { size: "1080x1920", count: 1 }],
    imagesSentForVisualQa: 2,
    truncated: false,
  };
  const drive = [
    { name: "Promo - 1080x1080 - v1.jpg" },
    { name: "Promo - 1080x1920 - v1.jpg" },
  ];
  const line = computeCompletenessLine(inv, drive);
  assert(line.includes("All approved Drive sizes are present"), "full coverage reported");
  assert(!line.includes("video(s) are excluded"), "no video note when there are no videos");
}

if (failures) {
  console.error(`\n${failures} assertion(s) FAILED.`);
  process.exit(1);
}
console.log("\nAll assertions passed.");
