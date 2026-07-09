// Month-aware Drive-ref discrimination (FIX #18).
//
// Agencies keep month folders side by side ("June 2026/", "July 2026/"), and a
// WO's linked root often queues BOTH months' approved creative. The TF-IDF
// matcher had no month signal: a June-pathed file sharing concept/version
// tokens with a July unit could tie (or beat) the July file — and ties resolve
// by queue order, which is alphabetical, so the OLD month wins. The model was
// then handed last promo's creative as "approved" → phantom mismatches.
//
// Rule (mirrors the v1/v2 version-token discrimination in rankRefsForUnit):
// when the unit has an expected month and at least one candidate ref carries
// that month, drop refs that carry ONLY different month(s). Month-agnostic
// refs always survive, and the filter NEVER empties the set — routing gets
// smarter, but no comparison is ever lost (degrade, don't assert).

import { tokenize } from "@/lib/format-check";

// Token → month number. Includes 3-letter abbreviations — filenames and unit
// names are structured metadata, not prose, so "jun"/"jul" are near-certain
// month markers there.
const MONTH_BY_TOKEN: Record<string, number> = {
  jan: 1, january: 1,
  feb: 2, february: 2,
  mar: 3, march: 3,
  apr: 4, april: 4,
  may: 5,
  jun: 6, june: 6,
  jul: 7, july: 7,
  aug: 8, august: 8,
  sep: 9, sept: 9, september: 9,
  oct: 10, october: 10,
  nov: 11, november: 11,
  dec: 12, december: 12,
};

// Months that double as common English words — trusted in structured names
// ("May Static V1", "March Madness 1080x1080.jpg") but NOT in prose, where
// "ads may vary" / "march into savings" would create false month expectations.
const AMBIGUOUS_IN_PROSE = new Set(["may", "mar", "march"]);

// Months found in a STRUCTURED name (ad unit name, Drive filename/path).
// All month tokens count, ambiguous ones included.
export function monthsInStructuredName(name: string): Set<number> {
  const out = new Set<number>();
  for (const t of tokenize(name)) {
    const m = MONTH_BY_TOKEN[t];
    if (m) out.add(m);
  }
  return out;
}

// Months found in PROSE (work-order text, ad body copy). Unambiguous month
// words count directly; "May"/"March" only count when they look like a date —
// capitalized and followed by a day number or a year ("May 31", "March 2026").
export function monthsInProse(text: string): Set<number> {
  const out = new Set<number>();
  for (const t of tokenize(text)) {
    const m = MONTH_BY_TOKEN[t];
    if (m && !AMBIGUOUS_IN_PROSE.has(t)) out.add(m);
  }
  // Date-pattern rescue for the ambiguous months (case-sensitive on purpose).
  const datePattern = /\b(May|March|Mar\.?)\s+(\d{1,2}(st|nd|rd|th)?|20\d{2})\b/g;
  for (const m of Array.from(text.matchAll(datePattern))) {
    out.add(m[1].startsWith("May") ? 5 : 3);
  }
  return out;
}

// The unit's expected month(s): its NAME is the strongest signal; the ad's
// body copy (prose-parsed, so "may vary" can't poison it) is next; the WO text
// is the fallback. Empty set = no expectation = filter is inert.
export function expectedMonthsForUnit(
  unitName: string,
  unitContent: string | null | undefined,
  woMonths: Set<number>
): Set<number> {
  const fromName = monthsInStructuredName(unitName);
  if (fromName.size) return fromName;
  const fromContent = monthsInProse(unitContent ?? "");
  if (fromContent.size) return fromContent;
  return woMonths;
}

// Drop candidate refs whose name/path carries ONLY month(s) outside the
// expected set. Guards, in order:
//   - no expected months → inert (return input unchanged)
//   - a month token carried by EVERY candidate is uninformative — it's a
//     client/campaign name ("Del Mar" → "mar", "May Co" → "may"), not a month
//     marker, and is ignored (the same signal-from-distribution idea as the
//     matcher's IDF weighting). A month only discriminates when some refs have
//     it and others don't.
//   - no candidate carries an expected (informative) month → no discrimination
//     possible → inert (we can't tell which month is "right", so don't guess)
//   - month-agnostic refs (no informative month token) always survive
//   - result would be empty → return input unchanged (never lose the comparison)
export function filterRefsByExpectedMonths<T>(
  refs: T[],
  nameOf: (r: T) => string,
  expected: Set<number>
): { kept: T[]; dropped: T[] } {
  if (!expected.size || refs.length === 0) return { kept: refs, dropped: [] };

  const monthSets = refs.map((r) => monthsInStructuredName(nameOf(r)));
  const counts = new Map<number, number>();
  for (const s of monthSets) for (const m of Array.from(s)) counts.set(m, (counts.get(m) ?? 0) + 1);
  // Informative = present in SOME but not ALL refs.
  const informative = (m: number) => (counts.get(m) ?? 0) > 0 && (counts.get(m) ?? 0) < refs.length;
  const effectiveSets = monthSets.map(
    (s) => new Set(Array.from(s).filter((m) => informative(m)))
  );
  const matchesExpected = (m: Set<number>) =>
    Array.from(m).some((x) => expected.has(x));

  const anyExpected = effectiveSets.some((s) => matchesExpected(s));
  if (!anyExpected) return { kept: refs, dropped: [] };

  const kept: T[] = [];
  const dropped: T[] = [];
  refs.forEach((r, i) => {
    const m = effectiveSets[i];
    if (m.size === 0 || matchesExpected(m)) kept.push(r);
    else dropped.push(r);
  });
  if (!kept.length) return { kept: refs, dropped: [] }; // never filter to empty
  return { kept, dropped };
}
