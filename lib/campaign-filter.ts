// Campaign-import keyword filter (Round 8, FIX #34).
//
// Workflow: an old campaign is re-run by duplicating its ad sets
// ("August Retargeting" -> "September Retargeting") and swapping the ads. The
// previous cycle's ads are usually left in place, turned off, and new ads are
// often off too pre-launch, so on/off status can't separate them.
//
// The keyword filter keeps an ad when the keyword is in its ad name OR its ad
// set name. That pulled a leftover "August Static V1" into a "September"
// filter whenever it sat in the September ad set. Rule: when the keyword names
// a month and the ad's OWN name carries only other month(s), skip it and
// report it by name, so a genuinely new ad that just missed a rename is
// visible in the load note instead of silently dropped. Ads with no month in
// their name are kept (nothing to judge), and non-month keywords behave
// exactly as before.
import { monthsInStructuredName } from "@/lib/month-match";

export function filterAdsByKeyword<T extends { name: string; adsetName?: string }>(
  ads: T[],
  keyword: string
): { kept: T[]; skippedOtherMonth: T[] } {
  const k = keyword.trim().toLowerCase();
  if (!k) return { kept: ads, skippedOtherMonth: [] };
  const matched = ads.filter(
    (ad) => ad.name.toLowerCase().includes(k) || (ad.adsetName ?? "").toLowerCase().includes(k)
  );
  const kwMonths = monthsInStructuredName(keyword);
  if (!kwMonths.size) return { kept: matched, skippedOtherMonth: [] };
  const kept: T[] = [];
  const skippedOtherMonth: T[] = [];
  for (const ad of matched) {
    const adMonths = monthsInStructuredName(ad.name);
    const conflicts = adMonths.size > 0 && !Array.from(adMonths).some((m) => kwMonths.has(m));
    (conflicts ? skippedOtherMonth : kept).push(ad);
  }
  return { kept, skippedOtherMonth };
}
