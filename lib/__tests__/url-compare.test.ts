/**
 * Regression tests for FIX #13 + FIX #15 (lib/url-compare.ts).
 *
 * FIX #13: URLs are extracted ONLY from URL-bearing field lines. A URL merely
 * mentioned in "Post copy:" / "Ad bodies:" must never count as a live
 * destination (it used to hard-FAIL URL matching).
 *
 * FIX #15: severity is primary vs secondary, not card vs non-card. A secondary
 * URL (carousel card OR extra per-asset Landing URL) on the approved host with
 * a different path is a deep-link → WARNING. FAIL is reserved for a primary
 * mismatch or any URL on a different domain.
 *
 * Run: npx tsx lib/__tests__/url-compare.test.ts
 */
import { extractLiveUrls, computeUrlMatchStatus, computeUrlComparisonLine } from "@/lib/url-compare";

let failures = 0;
function assert(cond: boolean, msg: string) {
  if (cond) console.log(`  ✓ ${msg}`);
  else { console.error(`  ✗ ${msg}`); failures++; }
}

const APPROVED = "https://www.resort.com/summer-offer";

console.log("Scenario 1 (FIX #13): URL in post copy is ignored");
{
  const content = [
    "Ad name: June Static V1",
    "Post copy: Book now at https://linktr.ee/resort and save big!",
    "Link URL: https://resort.com/summer-offer?utm_source=fb",
    "CTA: BOOK_TRAVEL",
  ].join("\n");
  const urls = extractLiveUrls(content);
  assert(urls.length === 1, "extracts only the Link URL field (copy-text URL ignored)");
  assert(urls[0]?.url.includes("resort.com"), "extracted URL is the destination field");
  assert(computeUrlMatchStatus(APPROVED, content) === "pass", "status = pass (copy-text URL can no longer FAIL the ad)");
}

console.log("Scenario 2 (FIX #13): ad bodies with URLs are ignored");
{
  const content = [
    "Ad bodies:",
    "  1. Visit https://other-site.com/promo today!",
    "Landing URLs:",
    "  1. https://resort.com/summer-offer",
  ].join("\n");
  const urls = extractLiveUrls(content);
  assert(urls.length === 1, "only the Landing URL is extracted");
  assert(computeUrlMatchStatus(APPROVED, content) === "pass", "status = pass");
}

console.log("Scenario 3 (FIX #15): secondary landing URL deep-link on approved host → warning, not fail");
{
  const content = [
    "Landing URLs:",
    "  1. https://resort.com/summer-offer",
    "  2. https://resort.com/rooms/suites",
  ].join("\n");
  assert(computeUrlMatchStatus(APPROVED, content) === "warning", "same-host secondary deep-link = warning");
  assert(computeUrlComparisonLine(APPROVED, content).includes("WARNING"), "prompt line says WARNING");
}

console.log("Scenario 4: primary mismatch still FAILs (no regression)");
{
  const content = "Destination URL: https://resort.com/winter-offer";
  assert(computeUrlMatchStatus(APPROVED, content) === "fail", "primary path mismatch = fail");
}

console.log("Scenario 5: secondary URL on a DIFFERENT domain still FAILs (no regression)");
{
  const content = [
    "Landing URLs:",
    "  1. https://resort.com/summer-offer",
    "  2. https://wrong-domain.com/summer-offer",
  ].join("\n");
  assert(computeUrlMatchStatus(APPROVED, content) === "fail", "cross-domain secondary = fail");
}

console.log("Scenario 6: carousel card deep-links still warning (no regression from FIX pre-13)");
{
  const content = [
    "Link URL: https://resort.com/summer-offer",
    "Carousel cards (2):",
    "  Card 1: headline: Suites | url: https://resort.com/rooms/suites | cta: LEARN_MORE",
    "  Card 2: headline: Pool | url: https://resort.com/amenities/pool | cta: LEARN_MORE",
  ].join("\n");
  assert(computeUrlMatchStatus(APPROVED, content) === "warning", "card deep-links = warning");
}

console.log("Scenario 7: tracking params ignored; matching still passes (no regression)");
{
  const content = "Destination URL: https://www.resort.com/summer-offer/?utm_source=facebook&fbclid=abc123";
  assert(computeUrlMatchStatus(APPROVED, content) === "pass", "tracking params + www + trailing slash ignored");
}

console.log("Scenario 8: no URL fields at all → unknown (no penalty)");
{
  const content = "Post copy: mentions https://resort.com/summer-offer in text only";
  assert(computeUrlMatchStatus(APPROVED, content) === "unknown", "copy-only URL → nothing to compare → unknown");
}

if (failures) { console.error(`\n${failures} assertion(s) FAILED`); process.exit(1); }
console.log("\nAll assertions passed.");
