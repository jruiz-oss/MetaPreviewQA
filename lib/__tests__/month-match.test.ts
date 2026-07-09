/**
 * Regression test for FIX #18: month-token discrimination in the Drive matcher.
 *
 * Sibling month folders ("June 2026/", "July 2026/") both queue creative; the
 * matcher had no month signal, so a June-pathed file sharing concept/version
 * tokens could be attached to a July unit as its "approved" creative → phantom
 * mismatch findings ("Vera sourced an old image").
 *
 * Rules under test (mirrors the v1/v2 version discrimination):
 *  - unit name months win; ad-copy/WO months are prose-parsed fallbacks
 *  - "ads may vary" / "march into savings" never create a month expectation
 *  - filter fires only when ≥1 candidate carries an expected month
 *  - month-agnostic files always survive; never filters to empty
 *
 * Run: npx tsx lib/__tests__/month-match.test.ts
 */
import {
  monthsInStructuredName,
  monthsInProse,
  expectedMonthsForUnit,
  filterRefsByExpectedMonths,
} from "@/lib/month-match";

let failures = 0;
function assert(cond: boolean, msg: string) {
  if (cond) console.log(`  ✓ ${msg}`);
  else { console.error(`  ✗ ${msg}`); failures++; }
}

type Ref = { name: string };
const nameOf = (r: Ref) => r.name;

console.log("Scenario 1: month parsing — structured names vs prose");
{
  assert(monthsInStructuredName("July Static V1").has(7), "unit name 'July Static V1' → July");
  assert(monthsInStructuredName("June 2026/Statics/HRok 1080x1080.jpg").has(6), "path 'June 2026/…' → June");
  assert(monthsInStructuredName("May Carousel V2").has(5), "unit name 'May Carousel V2' → May (names are structured)");
  assert(monthsInProse("Offer ends July 31. New June pricing.").has(7), "prose July detected");
  assert(!monthsInProse("Terms apply, ads may vary at participating stores").has(5), "'may vary' is NOT a May expectation");
  assert(!monthsInProse("March into savings this weekend").has(3), "'March into savings' (no date) NOT a March expectation");
  assert(monthsInProse("Sale runs May 31 only").has(5), "'May 31' (date pattern) IS May");
  assert(monthsInProse("Valid through March 2026").has(3), "'March 2026' (year pattern) IS March");
}

console.log("\nScenario 2: expected-month precedence — name > copy > WO");
{
  const wo = new Set([7]);
  assert(expectedMonthsForUnit("June Recap Static", "copy mentions July 4th", wo).has(6), "unit-name June beats copy/WO July");
  assert(expectedMonthsForUnit("Static V1", "Offer ends July 31", wo).has(7), "no name month → copy month");
  const fromWo = expectedMonthsForUnit("Static V1", "no dates in copy", wo);
  assert(fromWo.has(7) && fromWo.size === 1, "no name/copy month → WO month");
  assert(expectedMonthsForUnit("Static V1", "", new Set()).size === 0, "no months anywhere → no expectation (filter inert)");
}

console.log("\nScenario 3: the core bug — June leftovers dropped for a July unit");
{
  const refs: Ref[] = [
    { name: "June 2026/Static/HRok Promo 1080x1080.jpg" },
    { name: "July 2026/Static/HRok Promo 1080x1080.jpg" },
    { name: "July 2026/Static/HRok Promo 1080x1920.jpg" },
    { name: "Logo Lockup.png" }, // month-agnostic
  ];
  const { kept, dropped } = filterRefsByExpectedMonths(refs, nameOf, new Set([7]));
  assert(dropped.length === 1 && dropped[0].name.startsWith("June"), "June file dropped");
  assert(kept.length === 3, "both July files + month-agnostic file kept");
  assert(kept.some((r) => r.name === "Logo Lockup.png"), "month-agnostic file survives");
}

console.log("\nScenario 4: no discrimination possible → inert (never guess)");
{
  const refs: Ref[] = [
    { name: "June 2026/Static/Promo 1080x1080.jpg" },
    { name: "April/Old Promo 1080x1920.jpg" },
  ];
  // Expected July, but NO ref carries July — can't tell which is right, keep all.
  const { kept, dropped } = filterRefsByExpectedMonths(refs, nameOf, new Set([7]));
  assert(dropped.length === 0 && kept.length === 2, "no expected-month ref exists → nothing dropped");
}

console.log("\nScenario 5: never filters to empty");
{
  const refs: Ref[] = [{ name: "July Promo 1080x1080.jpg" }];
  const { kept } = filterRefsByExpectedMonths(refs, nameOf, new Set([7]));
  assert(kept.length === 1, "single matching ref kept");
  const none = filterRefsByExpectedMonths([] as Ref[], nameOf, new Set([7]));
  assert(none.kept.length === 0 && none.dropped.length === 0, "empty input stays empty without error");
}

console.log("\nScenario 6: multi-month ref survives when ANY of its months matches");
{
  const refs: Ref[] = [
    { name: "June-July Flight 1080x1080.jpg" }, // carries 6 AND 7
    { name: "June Only 1080x1920.jpg" },
    { name: "August Promo 1080x1080.jpg" },
  ];
  const { kept, dropped } = filterRefsByExpectedMonths(refs, nameOf, new Set([7]));
  assert(kept.some((r) => r.name.includes("June-July")), "June-July flight file kept for a July unit (one of its months matches)");
  assert(dropped.some((r) => r.name === "June Only 1080x1920.jpg"), "June-only file dropped");
  assert(dropped.some((r) => r.name === "August Promo 1080x1080.jpg"), "August file dropped");
}

console.log("\nScenario 7: client names containing month-like tokens stay safe");
{
  // "Del Mar" puts token "mar" (March) on EVERY file. A month carried by every
  // candidate is a client/campaign name, not a month marker — uninformative,
  // ignored. So a March expectation is inert, and for a July unit the
  // evergreen file counts as month-AGNOSTIC (its only month token is the
  // uninformative "mar") and survives.
  const refs: Ref[] = [
    { name: "Del Mar Resort/July/Spa 1080x1080.jpg" },
    { name: "Del Mar Resort/Evergreen/Pool 1080x1080.jpg" },
  ];
  const march = filterRefsByExpectedMonths(refs, nameOf, new Set([3]));
  assert(march.kept.length === 2 && march.dropped.length === 0, "'Del Mar' client: March expectation drops nothing ('mar' on every ref = uninformative)");
  const july = filterRefsByExpectedMonths(refs, nameOf, new Set([7]));
  assert(july.kept.length === 2 && july.dropped.length === 0, "July expectation: evergreen file is effectively month-agnostic → kept");
}

console.log("\nScenario 8: uninformative months don't block real discrimination");
{
  // Same client-name noise PLUS a genuine old-month leftover: "mar" is on all
  // three (uninformative), June/July remain informative → June dropped.
  const refs: Ref[] = [
    { name: "Del Mar Resort/July/Spa 1080x1080.jpg" },
    { name: "Del Mar Resort/June/Spa 1080x1080.jpg" },
    { name: "Del Mar Resort/Evergreen/Pool 1080x1080.jpg" },
  ];
  const { kept, dropped } = filterRefsByExpectedMonths(refs, nameOf, new Set([7]));
  assert(dropped.length === 1 && dropped[0].name.includes("/June/"), "June leftover still dropped despite client-name noise");
  assert(kept.length === 2, "July + evergreen kept");
}

if (failures) { console.error(`\n${failures} assertion(s) FAILED`); process.exit(1); }
console.log("\nAll assertions passed.");
