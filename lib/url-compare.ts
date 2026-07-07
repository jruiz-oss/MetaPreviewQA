// Deterministic URL comparison for the url_cta check — computed in code so the
// model never eyeball-matches URLs (and tracking params can't cause false
// fails). Extracted from app/api/qa/route.ts so it is unit-testable.

// Query params that are tracking noise — never a URL mismatch finding.
const TRACKING_PARAM_RE = /^(utm_|fbclid$|gclid$|gbraid$|wbraid$|msclkid$|ttclid$|mc_cid$|mc_eid$|igshid$|ref$)/i;

export function normalizeUrlForCompare(raw: string): { host: string; path: string; params: Map<string, string> } | null {
  try {
    const u = new URL(raw.trim());
    const host = u.hostname.toLowerCase().replace(/^www\./, "");
    const path = (u.pathname.replace(/\/+$/, "") || "/").toLowerCase();
    const params = new Map<string, string>();
    u.searchParams.forEach((v, k) => {
      if (!TRACKING_PARAM_RE.test(k)) params.set(k.toLowerCase(), v);
    });
    return { host, path, params };
  } catch {
    return null;
  }
}

// True when the live URL points at the approved destination: same host (www
// ignored) + same path (trailing slash/case ignored), and every meaningful
// (non-tracking) query param on the approved URL is present on the live URL.
// Extra non-tracking params on the live side are tolerated.
export function urlsMatch(approved: string, live: string): boolean {
  const a = normalizeUrlForCompare(approved);
  const l = normalizeUrlForCompare(live);
  if (!a || !l) return false;
  if (a.host !== l.host || a.path !== l.path) return false;
  for (const [k, v] of Array.from(a.params.entries())) {
    if (l.params.get(k) !== v) return false;
  }
  return true;
}

// Pull the click-through URLs out of the formatted Meta creative content.
//
// FIX #13: only URL-bearing FIELD lines are scanned (Destination URL, Link URL,
// CTA URL, Landing URLs list items, carousel card lines). The old version
// regexed URLs out of EVERY line — including "Post copy:" / "Ad bodies:" — so a
// vanity link or secondary URL merely MENTIONED in the ad's copy text was
// treated as a live destination and hard-FAILed URL matching. Copy-text URLs
// are the copy check's business, not the destination check's. ("Caption:" is
// also excluded — it's Meta's display link, not a click-through URL.)
//
// FIX #15: each URL is tagged primary vs secondary instead of just card vs
// non-card. Carousel cards AND extra Landing URLs (asset-feed ads carry one per
// asset/placement) are secondary — a secondary URL on the approved host with a
// different path is a deep-link (often intentional) and must not hard-FAIL the
// ad; only a PRIMARY mismatch or a different DOMAIN is a fail.
const URL_FIELD_LINE_RE = /^(Destination URL|Link URL|CTA URL):/;
const URL_LIST_HEADER_RE = /^Landing URLs:/;
const URL_LIST_ITEM_RE = /^\s+\d+\.\s/;
export type LiveUrl = { url: string; primary: boolean };
export function extractLiveUrls(content: string | null | undefined): LiveUrl[] {
  if (!content) return [];
  const out: LiveUrl[] = [];
  const seen = new Set<string>();
  let inUrlList = false;
  let landingUrlCount = 0;
  const push = (line: string, primary: boolean) => {
    for (const u of line.match(/https?:\/\/[^\s|,")\]]+/g) ?? []) {
      if (!seen.has(u)) {
        seen.add(u);
        out.push({ url: u, primary });
      }
    }
  };
  for (const line of content.split("\n")) {
    if (URL_LIST_HEADER_RE.test(line)) {
      inUrlList = true;
      continue;
    }
    if (inUrlList) {
      if (URL_LIST_ITEM_RE.test(line)) {
        // The FIRST landing URL is the ad's primary destination; the rest are
        // per-asset/per-placement variants (secondary).
        landingUrlCount++;
        push(line, landingUrlCount === 1);
        continue;
      }
      inUrlList = false; // list ended
    }
    if (/^\s*Card \d+:/.test(line)) {
      push(line, false); // carousel card — secondary
    } else if (URL_FIELD_LINE_RE.test(line)) {
      push(line, true); // named single destination field — primary
    }
  }
  return out;
}

// Shared verdict used by both the prompt line and the authoritative status.
// hard = primary URL mismatch, or ANY URL pointing at a different domain.
// soft = secondary URL (card / extra landing URL) on the approved host but a
// different path — a deep-link, warning-level only.
export function computeUrlMismatches(approvedUrl: string, content: string | null | undefined) {
  const liveUrls = extractLiveUrls(content);
  const mismatches = liveUrls.filter((u) => !urlsMatch(approvedUrl, u.url));
  const approvedHost = normalizeUrlForCompare(approvedUrl)?.host ?? null;
  const sameHost = (u: string) =>
    !!approvedHost && normalizeUrlForCompare(u)?.host === approvedHost;
  return {
    liveUrls,
    hard: mismatches.filter((m) => m.primary || !sameHost(m.url)),
    soft: mismatches.filter((m) => !m.primary && sameHost(m.url)),
  };
}

export function computeUrlComparisonLine(approvedUrl: string | null | undefined, content: string | null | undefined): string {
  // No approved URL in the WO → say so explicitly. Without this line the model
  // would eyeball-match URLs itself — the exact failure mode the computed
  // verdict exists to prevent.
  if (!approvedUrl) {
    return `\nURL comparison (computed): no approved destination URL was provided in the work order — do NOT judge URL matching; evaluate only the CTA.`;
  }
  const { liveUrls, hard, soft } = computeUrlMismatches(approvedUrl, content);
  if (!liveUrls.length) {
    return `\nURL comparison (computed): no destination URL found in the ad's creative fields — URL match could not be verified.`;
  }
  if (!hard.length && !soft.length) {
    return `\nURL comparison (computed): all ${liveUrls.length} live URL(s) match the approved destination (host + path compared; tracking params ignored). URL matching = PASS; evaluate only the CTA.`;
  }
  if (hard.length) {
    return `\nURL comparison (computed): MISMATCH — these live URL(s) do not point at the approved destination ${approvedUrl}: ${hard.map((m) => m.url).join(" , ")}. URL matching = FAIL.`;
  }
  return `\nURL comparison (computed): primary destination matches the approved URL, but ${soft.length} secondary URL(s) (carousel card or per-asset landing URL) deep-link to other pages on the approved domain: ${soft.map((m) => m.url).join(" , ")}. URL matching = WARNING (verify the deep-links are intentional); do not mark this a FAIL on URL matching alone.`;
}

// Same verdict as computeUrlComparisonLine, but as a status so the result
// assembly can make URL matching authoritative on the url_cta check (the model
// only judges the CTA). "unknown" = nothing to compare, so don't penalize.
export function computeUrlMatchStatus(
  approvedUrl: string | null | undefined,
  content: string | null | undefined
): "pass" | "fail" | "warning" | "unknown" {
  if (!approvedUrl) return "unknown";
  const { liveUrls, hard, soft } = computeUrlMismatches(approvedUrl, content);
  if (!liveUrls.length) return "unknown";
  if (hard.length) return "fail";
  if (soft.length) return "warning"; // only secondary deep-links differ
  return "pass";
}
