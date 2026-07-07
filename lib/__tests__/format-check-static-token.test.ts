/**
 * Regression test for FIX #17: "static" in the ad name must NOT force a
 * feed-size expectation.
 *
 * In ad naming "static" means still-image (vs video/carousel/GIF), not feed
 * placement. The old code treated it as a feed signal, so a "Story Static" or
 * "Static 9x16" unit with only a 1080x1920 asset hard-FAILed format_size
 * ("no 1:1 or 4:5 asset") even though it was a correctly-sized story static.
 *
 * Run: npx tsx lib/__tests__/format-check-static-token.test.ts
 */
import { computePlacementFormatCheck, computeFormatSizeCheck } from "@/lib/format-check";
import type { FormatInfo } from "@/lib/meta-api";

let failures = 0;
function assert(cond: boolean, msg: string) {
  if (cond) console.log(`  ✓ ${msg}`);
  else { console.error(`  ✗ ${msg}`); failures++; }
}

const storyOnly: FormatInfo = {
  placements: null,
  creativeDimensions: [{ width: 1080, height: 1920 }],
  adFormats: [],
  imageDimensions: [{ width: 1080, height: 1920 }],
};
const feedOnly: FormatInfo = {
  placements: null,
  creativeDimensions: [{ width: 1080, height: 1080 }],
  adFormats: [],
  imageDimensions: [{ width: 1080, height: 1080 }],
};

console.log("Scenario 1: 'Story Static' with only a 9:16 asset — no false FAIL");
{
  const r = computePlacementFormatCheck("May Story Static V1", storyOnly);
  assert(r.status === "pass", `status is pass (got ${r.status})`);
  assert(!r.note.includes("cropped in feed"), "no feed-crop complaint");
}

console.log("Scenario 2: 'Static 9x16' with only a 9:16 asset — no false FAIL");
{
  const r = computePlacementFormatCheck("Static 9x16", storyOnly);
  assert(r.status === "pass", `status is pass (got ${r.status})`);
}

console.log("Scenario 3: 'static' alone no longer implies feed — falls through to placement logic");
{
  // Story-only asset, name says only "Static": no format signal remains,
  // placements are null → generic pass, not a feed FAIL.
  const r = computePlacementFormatCheck("May Static V1", storyOnly);
  assert(r.status !== "fail", `not a fail (got ${r.status})`);
}

console.log("Scenario 4: real feed signals still enforce feed sizes (no regression)");
{
  const feed = computePlacementFormatCheck("May Feed V1", storyOnly);
  assert(feed.status === "fail", `'Feed' name + story-only asset still FAILs (got ${feed.status})`);
  const oneByOne = computePlacementFormatCheck("Concept 1x1 V2", storyOnly);
  assert(oneByOne.status === "fail", `'1x1' name + story-only asset still FAILs (got ${oneByOne.status})`);
  const ratio = computePlacementFormatCheck("Concept 4:5 V2", storyOnly);
  assert(ratio.status === "fail", `'4:5' name + story-only asset still FAILs (got ${ratio.status})`);
}

console.log("Scenario 5: story signal still enforced (no regression)");
{
  const r = computePlacementFormatCheck("May Story V1", feedOnly);
  assert(r.status === "fail", `'Story' name + feed-only asset still FAILs (got ${r.status})`);
}

console.log("Scenario 6: computeFormatSizeCheck wrapper — consistency rules still merge");
{
  const mixedCards: FormatInfo = {
    placements: null,
    creativeDimensions: [{ width: 1080, height: 1080 }],
    adFormats: [],
    cardDimensions: [
      { width: 1080, height: 1080 },
      { width: 1080, height: 1080 },
      { width: 2040, height: 1080 },
    ],
    imageDimensions: [{ width: 1080, height: 1080 }],
  };
  const r = computeFormatSizeCheck("May Carousel V1", mixedCards);
  assert(r.status === "fail", `mixed carousel card sizes still FAIL (got ${r.status})`);
  assert(r.note.includes("mixed sizes"), "note names the mixed-size defect");
}

if (failures) { console.error(`\n${failures} assertion(s) FAILED`); process.exit(1); }
console.log("\nAll assertions passed.");
