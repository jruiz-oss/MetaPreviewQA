/**
 * Regression test for FIX #34 (keyword filter month rule) and FIX #33
 * (ad-set month wins over a stale ad-name month in the Drive matcher).
 * Run: npx tsx lib/__tests__/campaign-filter.test.ts
 */
import { filterAdsByKeyword } from "@/lib/campaign-filter";
import { expectedMonthsForUnit } from "@/lib/month-match";

let failures = 0;
function assert(cond: boolean, msg: string) {
  if (cond) console.log(`  ✓ ${msg}`);
  else { console.log(`  ✗ ${msg}`); failures++; }
}

const ads = [
  { name: "September Static V1", adsetName: "September Retargeting" },
  { name: "August Static V1", adsetName: "September Retargeting" },
  { name: "Carousel 2", adsetName: "September Interest" },
  { name: "August Static V1", adsetName: "August Retargeting" },
  { name: "Aug-Sept Static", adsetName: "September Lookalike" },
];

console.log("Keyword filter");
{
  const r = filterAdsByKeyword(ads, "September");
  assert(r.kept.length === 3, `keeps September-named, month-less and multi-month ads (got ${r.kept.length})`);
  assert(r.skippedOtherMonth.length === 1 && r.skippedOtherMonth[0].name === "August Static V1", "skips the August leftover inside the September ad set");
  assert(!r.kept.some((a) => a.adsetName === "August Retargeting"), "August ad set still excluded");
  const s = filterAdsByKeyword(ads, "sept");
  assert(s.skippedOtherMonth.length === 1, "abbreviation keyword works the same");
  const n = filterAdsByKeyword(ads, "retargeting");
  assert(n.kept.length === 3 && n.skippedOtherMonth.length === 0, "non-month keyword unchanged");
  const e = filterAdsByKeyword(ads, "  ");
  assert(e.kept.length === ads.length, "empty keyword keeps everything");
}

console.log("\nExpected month for Drive matching");
{
  const none = new Set<number>();
  assert(Array.from(expectedMonthsForUnit("August Static V1", "", none, "September Retargeting")).join() === "9", "stale ad-name month loses to the ad set month");
  assert(Array.from(expectedMonthsForUnit("September Static V1", "", none, "September Retargeting")).join() === "9", "agreeing names unchanged");
  assert(Array.from(expectedMonthsForUnit("Static V1", "", none, "September Retargeting")).join() === "9", "month-less ad name falls back to the ad set");
  assert(Array.from(expectedMonthsForUnit("July Static V1", "", new Set([8]))).join() === "7", "no ad set: name still wins (old behavior)");
}

console.log(failures ? `\n${failures} assertion(s) FAILED` : "\nAll assertions passed.");
process.exit(failures ? 1 : 0);
