"use client";

import { useState, useEffect } from "react";
import { useRouter } from "next/navigation";

type AdUnit = {
  id: string;
  name: string;
  link: string;
  // Which campaign this unit was imported from. Manually-typed units have none
  // and are grouped together. Used to send one QA request per campaign.
  campaignId?: string;
};

type DriveImage = {
  id: string;
  name: string;
  mediaType: string;
};

type CheckResult = {
  status: "pass" | "fail" | "warning" | "unknown";
  note: string;
};

type UnitResult = {
  name: string;
  adId?: string | null;
  status: "pass" | "fail" | "warning";
  checks: {
    copy_creative_alignment: CheckResult;
    promo_month_date: CheckResult;
    url_cta: CheckResult;
    grammar_typos: CheckResult;
    ai_enhancements: CheckResult;
    format_size: CheckResult;
  };
  summary: string;
};

type QAResult = {
  overall_status: "pass" | "fail" | "warning";
  units: UnitResult[];
  critical_issues: string[];
  notes: string;
};

const CHECK_LABELS: Record<string, string> = {
  copy_creative_alignment: "Copy / creative match",
  promo_month_date: "Promo month & dates",
  url_cta: "URL & CTA destination",
  grammar_typos: "Grammar & typos",
  ai_enhancements: "Advantage+ AI enhancements",
  format_size: "Format & size",
};

// Order in which consolidated critical issues are grouped/scanned.
const CRITICAL_ORDER = [
  "copy_creative_alignment",
  "promo_month_date",
  "format_size",
  "url_cta",
  "grammar_typos",
  "ai_enhancements",
] as const;

type ConsolidatedIssue = { label: string; detail: string; units: string[] };

// Build the Critical issues summary by grouping FAILING checks across every ad
// unit, rather than concatenating each unit's individual issue list. Each ad is
// QA'd in its own model call, so the raw critical_issues array repeats the same
// problem once per ad (e.g. "missing June 14" twelve times). Here we bucket by
// check type, collect the affected ad names, and pick the most common phrasing
// as the representative description — so one shared problem reads as a single
// line "<issue> — affects ad A, ad B, ad C." Derived from the structured
// `checks` so it stays correct regardless of how many ads or batches ran.
function consolidateCriticalIssues(units: UnitResult[]): ConsolidatedIssue[] {
  const buckets = new Map<
    string,
    { units: string[]; noteCounts: Map<string, number> }
  >();

  for (const unit of units) {
    const name = unit.name || "Unnamed";
    for (const key of CRITICAL_ORDER) {
      const check = unit.checks?.[key];
      if (!check) continue;
      // ai_enhancements never returns "fail" — it's flagged critical when an
      // enhancement is actually ON (note names it), not for manual-check-only.
      const isCritical =
        check.status === "fail" ||
        (key === "ai_enhancements" && /\bON\b/.test(check.note));
      if (!isCritical) continue;

      if (!buckets.has(key)) buckets.set(key, { units: [], noteCounts: new Map() });
      const b = buckets.get(key)!;
      if (!b.units.includes(name)) b.units.push(name);
      const note = check.note?.trim();
      if (note) b.noteCounts.set(note, (b.noteCounts.get(note) ?? 0) + 1);
    }
  }

  return CRITICAL_ORDER.filter((key) => buckets.has(key))
    .map((key) => {
      const b = buckets.get(key)!;
      const detail =
        Array.from(b.noteCounts.entries()).sort((a, c) => c[1] - a[1])[0]?.[0] ?? "";
      return { label: CHECK_LABELS[key], detail, units: b.units };
    })
    // Most widely-shared problems first.
    .sort((a, c) => c.units.length - a.units.length);
}

function StatusBadge({ status }: { status: string }) {
  const styles: Record<string, string> = {
    pass: "bg-emerald-50 text-emerald-700 border border-emerald-200",
    fail: "bg-red-50 text-red-700 border border-red-200",
    warning: "bg-amber-50 text-amber-700 border border-amber-200",
    unknown: "bg-gray-100 text-gray-500 border border-gray-200",
  };
  const labels: Record<string, string> = {
    pass: "Pass",
    fail: "Fail",
    warning: "Warning",
    unknown: "N/A",
  };
  return (
    <span className={`text-xs font-medium px-2 py-0.5 rounded-full ${styles[status] ?? styles.unknown}`}>
      {labels[status] ?? status}
    </span>
  );
}

// Small monospace ad ID with a one-click copy button, so reviewers can grab the
// exact ID to double-check an ad in Ads Manager without retyping it.
function AdIdBadge({ adId }: { adId: string }) {
  const [copied, setCopied] = useState(false);

  async function copy() {
    try {
      await navigator.clipboard.writeText(adId);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // Clipboard API unavailable (e.g. non-secure context) — the text is still
      // selectable, so the user can copy manually.
    }
  }

  return (
    <button
      type="button"
      onClick={copy}
      title="Copy ad ID"
      className="group inline-flex items-center gap-1.5 rounded-md bg-gray-100 px-2 py-0.5 font-mono text-xs text-gray-600 hover:bg-gray-200 select-all"
    >
      <span>{adId}</span>
      <span className="text-gray-400 group-hover:text-gray-600 select-none">
        {copied ? "✓" : "⧉"}
      </span>
    </button>
  );
}

function CheckRow({ label, result }: { label: string; result: CheckResult }) {
  const icons: Record<string, string> = {
    pass: "✓",
    fail: "✗",
    warning: "!",
    unknown: "–",
  };
  const colors: Record<string, string> = {
    pass: "text-emerald-600",
    fail: "text-red-600",
    warning: "text-amber-600",
    unknown: "text-gray-400",
  };
  return (
    <div className="flex items-start gap-3 py-2.5 border-b border-gray-100 last:border-0">
      <span className={`font-semibold text-sm w-4 shrink-0 mt-0.5 ${colors[result.status] ?? colors.unknown}`}>
        {icons[result.status] ?? "–"}
      </span>
      <div className="flex-1 min-w-0">
        <p className="text-sm font-medium text-gray-700">{label}</p>
        {result.note && (
          <p className="text-sm text-gray-500 mt-0.5">{result.note}</p>
        )}
      </div>
    </div>
  );
}

export default function QAPage() {
  const router = useRouter();
  const [wo, setWo] = useState("");
  const [detectedDocs, setDetectedDocs] = useState<{ url: string; woLabel: string; content: string | null; images: DriveImage[]; error: string | null; loading: boolean }[]>([]);
  const [woDestinationUrl, setWoDestinationUrl] = useState<string | null>(null);
  const [units, setUnits] = useState<AdUnit[]>([
    { id: "1", name: "", link: "" },
    { id: "2", name: "", link: "" },
  ]);
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<QAResult | null>(null);
  const [error, setError] = useState("");
  // Progress across per-campaign QA requests (done / total campaigns).
  const [progress, setProgress] = useState<{ done: number; total: number }>({ done: 0, total: 0 });

  // Campaign import state — supports multiple campaigns
  type FilterScope = "ad" | "adset" | "both";
  type CampaignRow = {
    id: string;
    campaignId: string;
    filter: string;
    filterScope: FilterScope;
    loading: boolean;
    loaded: boolean;
    error: string;
  };
  const [campaigns, setCampaigns] = useState<CampaignRow[]>([
    { id: "c1", campaignId: "", filter: "", filterScope: "ad", loading: false, loaded: false, error: "" },
  ]);

  function addCampaignRow() {
    setCampaigns((prev) => [
      ...prev,
      { id: String(Date.now()), campaignId: "", filter: "", filterScope: "ad", loading: false, loaded: false, error: "" },
    ]);
  }

  function removeCampaignRow(id: string) {
    if (campaigns.length <= 1) {
      setCampaigns([{ id: "c1", campaignId: "", filter: "", filterScope: "ad", loading: false, loaded: false, error: "" }]);
    } else {
      setCampaigns((prev) => prev.filter((c) => c.id !== id));
    }
  }

  function updateCampaignRow(
    id: string,
    field: "campaignId" | "filter" | "filterScope",
    value: string
  ) {
    setCampaigns((prev) =>
      prev.map((c) => (c.id === id ? { ...c, [field]: value, error: "", loaded: false } : c))
    );
  }

  function addUnit() {
    setUnits((prev) => [
      ...prev,
      { id: String(Date.now()), name: "", link: "" },
    ]);
  }

  function removeUnit(id: string) {
    if (units.length <= 1) return;
    setUnits((prev) => prev.filter((u) => u.id !== id));
  }

  function extractAdId(input: string): string {
    const trimmed = input.trim();
    // Already a numeric ID
    if (/^\d{10,}$/.test(trimmed)) return trimmed;
    try {
      const urlStr = trimmed.startsWith("http") ? trimmed : `https://${trimmed}`;
      const url = new URL(urlStr);
      const fromParams =
        url.searchParams.get("id") ||
        url.searchParams.get("ad_id") ||
        url.searchParams.get("creative_id") ||
        url.searchParams.get("selected_ad_ids");
      if (fromParams) return fromParams.split(",")[0].trim();
    } catch {
      // not a URL, return as-is
    }
    return trimmed;
  }

  function updateUnit(id: string, field: "name" | "link", value: string) {
    const resolved = field === "link" ? extractAdId(value) : value;
    setUnits((prev) =>
      prev.map((u) => (u.id === id ? { ...u, [field]: resolved } : u))
    );
  }

  const GOOGLE_LINK_RE =
    /https:\/\/(?:docs\.google\.com\/document\/d\/|drive\.google\.com\/(?:drive\/(?:u\/\d+\/)?folders\/|file\/d\/))[a-zA-Z0-9_-]+(?:\/[^\s"')]*)?/g;

  // Extract labeled links from WO — returns [{woLabel, url}] for Google links
  // and sets woDestinationUrl for the first non-Google https URL labeled "URL"
  function parseLabeledLinks(text: string): { woLabel: string; url: string }[] {
    // Match patterns like "Label: https://..." or "Label:\nhttps://..."
    const labelRe = /([A-Za-z][A-Za-z0-9 /()_-]{0,30}?):\s*(https:\/\/[^\s\n"')]+)/g;
    const results: { woLabel: string; url: string }[] = [];
    const seenUrls = new Set<string>();
    let match;
    while ((match = labelRe.exec(text)) !== null) {
      const woLabel = match[1].trim();
      const url = match[2].trim();
      if (seenUrls.has(url)) continue;
      seenUrls.add(url);
      // Destination URL (non-Google) — store separately
      if (!GOOGLE_LINK_RE.test(url)) {
        GOOGLE_LINK_RE.lastIndex = 0;
        const lowerLabel = woLabel.toLowerCase();
        if (lowerLabel.includes("url") || lowerLabel.includes("link") || lowerLabel.includes("destination")) {
          setWoDestinationUrl(url);
        }
        continue;
      }
      GOOGLE_LINK_RE.lastIndex = 0;
      results.push({ woLabel, url });
    }
    // Fallback: pick up any Google links not caught by label pattern
    const rawMatches = Array.from(text.matchAll(GOOGLE_LINK_RE)).map((m) => m[0]);
    GOOGLE_LINK_RE.lastIndex = 0;
    for (const url of rawMatches) {
      if (!seenUrls.has(url)) {
        seenUrls.add(url);
        results.push({ woLabel: "Document", url });
      }
    }
    return results;
  }

  function displayLabel(doc: { woLabel: string; url: string }): string {
    if (doc.woLabel && doc.woLabel !== "Document") return doc.woLabel;
    if (doc.url.includes("docs.google.com")) return "Google Doc";
    if (doc.url.includes("/folders/")) return "Drive Folder";
    return "Drive File";
  }

  async function handleWoChange(value: string) {
    setWo(value);
    setWoDestinationUrl(null);
    const labeled = parseLabeledLinks(value);
    if (labeled.length === 0) {
      setDetectedDocs([]);
      return;
    }
    setDetectedDocs((prev) => {
      const existingUrls = new Set(prev.map((d) => d.url));
      const toKeep = prev.filter((d) => labeled.some((l) => l.url === d.url));
      const toAdd = labeled.filter((l) => !existingUrls.has(l.url));
      return [
        ...toKeep,
        ...toAdd.map((l) => ({ url: l.url, woLabel: l.woLabel, content: null, images: [], error: null, loading: false })),
      ];
    });
  }

  async function loadDoc(url: string) {
    setDetectedDocs((prev) =>
      prev.map((d) => (d.url === url ? { ...d, loading: true, error: null } : d))
    );
    try {
      const res = await fetch("/api/fetch-doc", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Failed to fetch doc");
      setDetectedDocs((prev) =>
        prev.map((d) =>
          d.url === url ? { ...d, loading: false, content: data.content, images: data.images ?? [] } : d
        )
      );
    } catch (err) {
      setDetectedDocs((prev) =>
        prev.map((d) =>
          d.url === url
            ? { ...d, loading: false, error: err instanceof Error ? err.message : "Failed" }
            : d
        )
      );
    }
  }

  // Auto-load any newly detected docs that haven't been fetched yet
  useEffect(() => {
    const pending = detectedDocs.filter((d) => !d.content && !d.error && !d.loading);
    pending.forEach((d) => loadDoc(d.url));
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [detectedDocs.map((d) => d.url).join(",")]);

  async function loadFromCampaign(rowId: string) {
    const row = campaigns.find((c) => c.id === rowId);
    if (!row || !row.campaignId.trim()) return;

    setCampaigns((prev) =>
      prev.map((c) => (c.id === rowId ? { ...c, loading: true, error: "" } : c))
    );

    try {
      const res = await fetch("/api/campaign-ads", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ campaignId: row.campaignId.trim() }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Failed to load campaign ads");

      const keyword = row.filter.trim().toLowerCase();
      const scope = row.filterScope;
      const filtered = keyword
        ? data.ads.filter((ad: { id: string; name: string; adsetName?: string }) => {
            const adMatch = ad.name.toLowerCase().includes(keyword);
            const adsetMatch = (ad.adsetName ?? "").toLowerCase().includes(keyword);
            if (scope === "ad") return adMatch;
            if (scope === "adset") return adsetMatch;
            return adMatch || adsetMatch;
          })
        : data.ads;

      if (filtered.length === 0) {
        const where =
          scope === "ad" ? "ad name" : scope === "adset" ? "ad set name" : "ad or ad set name";
        throw new Error(
          keyword
            ? `No ads matched "${row.filter.trim()}" in ${where} — try a different keyword or scope.`
            : "No ads found in this campaign."
        );
      }

      const importedCampaignId = row.campaignId.trim();
      const imported: AdUnit[] = filtered.map((ad: { id: string; name: string }) => ({
        id: String(Date.now()) + ad.id,
        name: ad.name,
        link: ad.id,
        campaignId: importedCampaignId,
      }));

      // Append to existing units (remove empty placeholder rows first)
      setUnits((prev) => {
        const nonEmpty = prev.filter((u) => u.link.trim() || u.name.trim());
        return nonEmpty.length > 0 ? [...nonEmpty, ...imported] : imported;
      });

      setCampaigns((prev) =>
        prev.map((c) => (c.id === rowId ? { ...c, loading: false, loaded: true } : c))
      );
    } catch (err) {
      setCampaigns((prev) =>
        prev.map((c) =>
          c.id === rowId
            ? { ...c, loading: false, error: err instanceof Error ? err.message : "Something went wrong" }
            : c
        )
      );
    }
  }

  // Rank used to roll individual unit statuses up into an overall status.
  function statusRank(s: string): number {
    return s === "fail" ? 2 : s === "warning" ? 1 : 0;
  }

  async function runQA() {
    if (!wo.trim()) return;
    const filledUnits = units.filter((u) => u.link.trim());
    if (filledUnits.length === 0) return;

    // Group units by the campaign they were imported from. Manually-typed units
    // (no campaignId) form one extra group so they're still checked. Each group
    // becomes its own /api/qa request, keeping every request small and well under
    // Vercel's 300s limit, and letting results stream in campaign-by-campaign.
    const groupsMap = new Map<string, AdUnit[]>();
    for (const u of filledUnits) {
      const key = u.campaignId ?? "__manual__";
      if (!groupsMap.has(key)) groupsMap.set(key, []);
      groupsMap.get(key)!.push(u);
    }
    const groups = Array.from(groupsMap.entries()).map(([key, us]) => ({
      key,
      label: key === "__manual__" ? "Manually added units" : `Campaign ${key}`,
      units: us,
    }));

    setLoading(true);
    setResult({ overall_status: "pass", units: [], critical_issues: [], notes: "" });
    setError("");
    setProgress({ done: 0, total: groups.length });

    const labeledDocs = detectedDocs
      .filter((d) => d.content)
      .map((d) => ({ label: d.woLabel, content: d.content }));

    // Only cross-reference images from the link labeled as the creative (e.g.
    // "Updated Creative:"). A WO usually also links a broad JOB FOLDER that
    // contains the entire campaign (copy, every concept, approvals, incoming) —
    // pulling images from that dumps dozens of irrelevant assets onto every ad.
    // If no creative-labeled link exists, fall back to all detected images.
    const creativeDocs = detectedDocs.filter((d) => /creativ/i.test(d.woLabel));
    const imageSourceDocs = creativeDocs.length > 0 ? creativeDocs : detectedDocs;
    const driveImages = imageSourceDocs.flatMap((d) => d.images ?? []);

    const errors: string[] = [];

    async function runGroup(group: (typeof groups)[number]) {
      try {
        const res = await fetch("/api/qa", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            wo,
            units: group.units,
            labeledDocs,
            driveImages,
            destinationUrl: woDestinationUrl ?? null,
          }),
        });

        // Read as text first: a Vercel 504 returns an HTML/text page, not JSON.
        const rawBody = await res.text();
        let data: { error?: string } & Record<string, unknown> = {};
        try {
          data = rawBody ? JSON.parse(rawBody) : {};
        } catch {
          throw new Error(
            res.status === 504
              ? `${group.label}: timed out (504) — too many units in this campaign.`
              : `${group.label}: unexpected response (HTTP ${res.status}).`
          );
        }
        if (!res.ok) {
          throw new Error(data.error ?? `${group.label}: QA check failed (HTTP ${res.status})`);
        }

        const partial = data as unknown as QAResult;
        // Merge this campaign's results into the accumulating result as soon as
        // it returns, so the user sees results stream in rather than waiting.
        setResult((prev) => {
          const base = prev ?? { overall_status: "pass" as QAResult["overall_status"], units: [], critical_issues: [], notes: "" };
          const mergedUnits = [...base.units, ...(partial.units ?? [])];
          const mergedCritical = [...base.critical_issues, ...(partial.critical_issues ?? [])];
          const worst = mergedUnits.reduce(
            (w, u) => (statusRank(u.status) > statusRank(w) ? u.status : w),
            "pass" as QAResult["overall_status"]
          );
          return { overall_status: worst, units: mergedUnits, critical_issues: mergedCritical, notes: "" };
        });
      } catch (err) {
        errors.push(err instanceof Error ? err.message : `${group.label}: something went wrong`);
      } finally {
        setProgress((p) => ({ done: p.done + 1, total: p.total }));
      }
    }

    // Run campaigns with limited client-side concurrency so we don't fire every
    // request at once. Each request still batches internally on the server.
    const MAX_CONCURRENT = 2;
    let idx = 0;
    const worker = async (): Promise<void> => {
      while (idx < groups.length) {
        const myIdx = idx++;
        await runGroup(groups[myIdx]);
      }
    };
    await Promise.all(
      Array.from({ length: Math.min(MAX_CONCURRENT, groups.length) }, () => worker())
    );

    if (errors.length > 0) setError(errors.join("  "));
    setLoading(false);
  }

  function reset() {
    // Full clear of all input boxes — stays logged in (no auth touched)
    setWo("");
    setDetectedDocs([]);
    setWoDestinationUrl(null);
    setUnits([
      { id: "1", name: "", link: "" },
      { id: "2", name: "", link: "" },
    ]);
    setCampaigns([
      { id: "c1", campaignId: "", filter: "", filterScope: "ad", loading: false, loaded: false, error: "" },
    ]);
    setResult(null);
    setError("");
    setProgress({ done: 0, total: 0 });
  }

  const CHECK_NAMES = [
    "Copy / creative alignment",
    "Promo month & dates",
    "URL & CTA destination",
    "Grammar & typos",
    "Advantage+ AI enhancements",
    "Format & size",
  ];

  const [checkIdx, setCheckIdx] = useState(0);

  useEffect(() => {
    if (!loading) return;
    const interval = setInterval(() => {
      setCheckIdx((i) => (i + 1) % CHECK_NAMES.length);
    }, 3000);
    return () => clearInterval(interval);
  }, [loading]);

  return (
    <div className="min-h-screen bg-[#f8f8f6]">
      <header className="border-b border-gray-200 bg-white px-6 py-4 flex items-center justify-between">
        <div className="flex items-center gap-3">
          <span className="text-xs font-medium tracking-widest text-gray-400 uppercase">Commit Agency</span>
          <span className="text-gray-200">|</span>
          <img
            src="/vera-wordmark-transparent.png"
            alt="Vera"
            className="h-[42px] cursor-pointer"
            onClick={reset}
          />
        </div>
        {result && (
          <button
            onClick={reset}
            className="text-sm text-gray-500 hover:text-gray-900 transition-colors"
          >
            ← New check
          </button>
        )}
      </header>

      <main className="max-w-3xl mx-auto px-6 py-8">
        {loading && (!result || result.units.length === 0) ? (
          /* ── QA Running Animation ─────────────────────────── */
          <div className="flex flex-col items-center justify-center min-h-[62vh] gap-8 select-none">
            {/* Orbital ring system */}
            <div className="relative flex items-center justify-center" style={{ width: 160, height: 160 }}>
              {/* Pulsing rings */}
              <div className="qa-ring-3 absolute rounded-full border border-gray-300/50" style={{ width: 150, height: 150 }} />
              <div className="qa-ring-2 absolute rounded-full border border-gray-400/50" style={{ width: 118, height: 118 }} />
              <div className="qa-ring-1 absolute rounded-full border border-gray-500/60" style={{ width: 88, height: 88 }} />

              {/* Orbiting dots */}
              <div className="absolute" style={{ width: 0, height: 0 }}>
                <div className="qa-dot-1 absolute" style={{ width: 0, height: 0 }}>
                  <div style={{ width: 8, height: 8, borderRadius: "50%", background: "#111827", position: "absolute", top: -4, left: -4 }} />
                </div>
                <div className="qa-dot-2 absolute" style={{ width: 0, height: 0 }}>
                  <div style={{ width: 5, height: 5, borderRadius: "50%", background: "#6b7280", position: "absolute", top: -2.5, left: -2.5 }} />
                </div>
                <div className="qa-dot-3 absolute" style={{ width: 0, height: 0 }}>
                  <div style={{ width: 5, height: 5, borderRadius: "50%", background: "#9ca3af", position: "absolute", top: -2.5, left: -2.5 }} />
                </div>
              </div>

              {/* Core circle with scan line */}
              <div className="qa-core relative flex items-center justify-center rounded-full bg-gray-900 overflow-hidden" style={{ width: 52, height: 52 }}>
                <div
                  className="qa-scan absolute"
                  style={{
                    width: 38,
                    height: 1.5,
                    background: "linear-gradient(90deg, transparent, rgba(255,255,255,0.85), transparent)",
                    borderRadius: 4,
                  }}
                />
                <svg width="22" height="22" viewBox="0 0 24 24" fill="none" style={{ position: "relative", zIndex: 1 }}>
                  <path d="M9 12l2 2 4-4M21 12a9 9 0 11-18 0 9 9 0 0118 0z" stroke="white" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"/>
                </svg>
              </div>
            </div>

            {/* Label + cycling check name */}
            <div className="text-center space-y-3">
              <p className="text-sm font-semibold text-gray-900 tracking-wide">Running QA check</p>
              <p className="text-xs text-gray-400">This usually takes 2–5 minutes. Hang tight.</p>
              <div style={{ height: 22, overflow: "hidden", position: "relative" }}>
                <p key={checkIdx} className="qa-check-label text-sm text-gray-400">
                  Checking: {CHECK_NAMES[checkIdx]}
                </p>
              </div>
              {/* Progress pill row */}
              <div className="flex items-center justify-center gap-1.5 pt-1">
                {CHECK_NAMES.map((_, i) => (
                  <div
                    key={i}
                    style={{
                      width: i === checkIdx ? 18 : 4,
                      height: 4,
                      borderRadius: 9999,
                      background: i === checkIdx ? "#111827" : "#d1d5db",
                      transition: "width 0.4s ease, background 0.4s ease",
                    }}
                  />
                ))}
              </div>
            </div>
          </div>
        ) : !result || result.units.length === 0 ? (
          <div className="space-y-5">
            {/* Step 1 — Work Order */}
            <div className="bg-white rounded-2xl border border-gray-200 p-6">
              <div className="mb-4">
                <p className="text-xs font-medium tracking-widest text-gray-400 uppercase mb-1">
                  Step 1
                </p>
                <h2 className="text-base font-semibold text-gray-900">
                  Work order description
                </h2>
                <p className="text-sm text-gray-500 mt-0.5">
                  Paste the full WO — campaign name, offer, creative direction,
                  expected URLs
                </p>
              </div>
              <textarea
                value={wo}
                onChange={(e) => handleWoChange(e.target.value)}
                rows={6}
                placeholder="Paste your full work order here — campaign name, offer, creative direction, expected URLs, launch/end dates."
                className="w-full px-4 py-3 rounded-xl border border-gray-200 bg-gray-50 text-sm text-gray-900 placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-gray-900 focus:border-transparent resize-none"
              />

              {/* Detected destination URL */}
              {woDestinationUrl && (
                <div className="mt-3 px-4 py-3 rounded-xl border border-indigo-200 bg-indigo-50 text-sm flex items-start gap-2">
                  <span className="text-xs font-semibold text-indigo-700 shrink-0 mt-0.5">URL</span>
                  <p className="text-xs text-indigo-600 truncate">{woDestinationUrl}</p>
                </div>
              )}

              {/* Auto-detected Google links */}
              {detectedDocs.length > 0 && (
                <div className="mt-3 space-y-2">
                  <p className="text-xs font-medium text-gray-400 uppercase tracking-wide">
                    Google links detected in WO
                  </p>
                  {detectedDocs.map((doc) => (
                    <div
                      key={doc.url}
                      className={`flex items-start gap-3 px-4 py-3 rounded-xl border text-sm ${
                        doc.content
                          ? "bg-emerald-50 border-emerald-200"
                          : doc.error
                          ? "bg-red-50 border-red-200"
                          : doc.loading
                          ? "bg-blue-50 border-blue-200"
                          : "bg-gray-50 border-gray-200"
                      }`}
                    >
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2 mb-0.5">
                          <span className="text-xs font-semibold text-gray-700">
                            {displayLabel(doc)}
                          </span>
                        </div>
                        <p className="text-xs text-gray-400 truncate">{doc.url}</p>
                        {doc.loading && (
                          <p className="text-xs text-blue-600 mt-0.5">Loading content…</p>
                        )}
                        {doc.content && (
                          <p className="text-xs text-emerald-700 mt-0.5">
                            ✓ Loaded — {doc.content.length.toLocaleString()} chars
                            {doc.images.length > 0 && ` + ${doc.images.length} image${doc.images.length === 1 ? "" : "s"}`} read into QA
                          </p>
                        )}
                        {doc.error && (
                          <p className="text-xs text-red-600 mt-0.5">{doc.error}</p>
                        )}
                      </div>
                      {doc.loading && (
                        <span className="shrink-0 inline-block w-4 h-4 border-2 border-gray-300 border-t-gray-700 rounded-full animate-spin mt-1" />
                      )}
                      {doc.error && !doc.loading && (
                        <button
                          onClick={() => loadDoc(doc.url)}
                          className="shrink-0 px-3 py-1.5 rounded-lg bg-gray-900 text-white text-xs font-medium hover:bg-gray-800 transition-colors"
                        >
                          Retry
                        </button>
                      )}
                    </div>
                  ))}
                </div>
              )}
            </div>

            {/* Step 2 — Ad Units */}
            <div className="bg-white rounded-2xl border border-gray-200 p-6">
              <div className="mb-4">
                <p className="text-xs font-medium tracking-widest text-gray-400 uppercase mb-1">
                  Step 2
                </p>
                <h2 className="text-base font-semibold text-gray-900">
                  Ad units
                </h2>
                <p className="text-sm text-gray-500 mt-0.5">
                  Paste a <strong>Campaign ID</strong> above to auto-load all ads, or add them individually below using an Ad ID or Ads Manager URL.
                </p>
              </div>

              {/* Campaign import — multi-campaign */}
              <div className="mb-5 pb-5 border-b border-gray-100 space-y-2">
                <div className="grid grid-cols-[1fr_auto_auto_auto_32px] gap-2 px-1 mb-1">
                  <span className="text-xs font-medium text-gray-400 uppercase tracking-wide">Campaign ID</span>
                  <span className="text-xs font-medium text-gray-400 uppercase tracking-wide w-40">Filter (optional)</span>
                  <span className="text-xs font-medium text-gray-400 uppercase tracking-wide w-32">Match on</span>
                  <span />
                  <span />
                </div>

                {campaigns.map((row) => (
                  <div key={row.id} className="space-y-1">
                    <div className="grid grid-cols-[1fr_auto_auto_auto_32px] gap-2 items-center">
                      <input
                        type="text"
                        value={row.campaignId}
                        onChange={(e) => updateCampaignRow(row.id, "campaignId", e.target.value)}
                        placeholder="Paste campaign ID"
                        className="px-3 py-2.5 rounded-xl border border-gray-200 bg-gray-50 text-sm text-gray-900 placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-gray-900 focus:border-transparent"
                      />
                      <input
                        type="text"
                        value={row.filter}
                        onChange={(e) => updateCampaignRow(row.id, "filter", e.target.value)}
                        placeholder="e.g. june"
                        className="w-40 px-3 py-2.5 rounded-xl border border-gray-200 bg-gray-50 text-sm text-gray-900 placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-gray-900 focus:border-transparent"
                      />
                      <select
                        value={row.filterScope}
                        onChange={(e) => updateCampaignRow(row.id, "filterScope", e.target.value)}
                        className="w-32 pl-3 pr-9 py-2.5 rounded-xl border border-gray-200 bg-gray-50 text-sm text-gray-900 focus:outline-none focus:ring-2 focus:ring-gray-900 focus:border-transparent appearance-none bg-no-repeat bg-[right_0.75rem_center] bg-[length:1rem] bg-[url('data:image/svg+xml;charset=utf-8,%3Csvg%20xmlns%3D%22http%3A//www.w3.org/2000/svg%22%20fill%3D%22none%22%20viewBox%3D%220%200%2020%2020%22%3E%3Cpath%20stroke%3D%22%236b7280%22%20stroke-linecap%3D%22round%22%20stroke-linejoin%3D%22round%22%20stroke-width%3D%221.5%22%20d%3D%22M6%208l4%204%204-4%22/%3E%3C/svg%3E')]"
                      >
                        <option value="ad">Ad name</option>
                        <option value="adset">Ad set name</option>
                        <option value="both">Either</option>
                      </select>
                      <button
                        onClick={() => loadFromCampaign(row.id)}
                        disabled={row.loading || row.loaded || !row.campaignId.trim()}
                        className={`px-4 py-2.5 rounded-xl text-sm font-medium transition-colors whitespace-nowrap flex items-center gap-2 ${
                          row.loaded
                            ? "bg-gray-200 text-gray-400 cursor-not-allowed"
                            : "bg-gray-900 text-white hover:bg-gray-800 disabled:opacity-40 disabled:cursor-not-allowed"
                        }`}
                      >
                        {row.loading ? (
                          <>
                            <span className="inline-block w-3.5 h-3.5 border-2 border-white/30 border-t-white rounded-full animate-spin" />
                            Loading...
                          </>
                        ) : row.loaded ? (
                          <>
                            <span className="text-emerald-500">✓</span>
                            Loaded
                          </>
                        ) : (
                          "Load ads"
                        )}
                      </button>
                      <button
                        onClick={() => removeCampaignRow(row.id)}
                        className="flex items-center justify-center w-8 h-8 rounded-lg text-gray-400 hover:text-gray-700 hover:bg-gray-100 transition-colors"
                        title="Remove"
                      >
                        ×
                      </button>
                    </div>
                    {row.error && (
                      <p className="text-xs text-red-600 pl-1">{row.error}</p>
                    )}
                  </div>
                ))}

                <button
                  onClick={addCampaignRow}
                  className="w-full py-2 rounded-xl border border-dashed border-gray-300 text-sm text-gray-500 hover:text-gray-700 hover:border-gray-400 transition-colors"
                >
                  + Add another campaign
                </button>
              </div>

              {/* Column headers */}
              <div className="grid grid-cols-[1fr_2fr_32px] gap-3 mb-2 px-1">
                <span className="text-xs font-medium text-gray-400 uppercase tracking-wide">
                  Ad unit name
                </span>
                <span className="text-xs font-medium text-gray-400 uppercase tracking-wide">
                  Ad ID or URL
                </span>
                <span />
              </div>

              <div className="space-y-2">
                {units.map((unit) => (
                  <div
                    key={unit.id}
                    className="grid grid-cols-[1fr_2fr_32px] gap-3 items-center"
                  >
                    <input
                      type="text"
                      value={unit.name}
                      onChange={(e) =>
                        updateUnit(unit.id, "name", e.target.value)
                      }
                      placeholder="e.g. Static"
                      className="px-3 py-2.5 rounded-xl border border-gray-200 bg-gray-50 text-sm text-gray-900 placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-gray-900 focus:border-transparent"
                    />
                    <input
                      type="text"
                      value={unit.link}
                      onChange={(e) =>
                        updateUnit(unit.id, "link", e.target.value)
                      }
                      placeholder="e.g. 120210001234567 or facebook.com/ads/preview/?id=..."
                      className="px-3 py-2.5 rounded-xl border border-gray-200 bg-gray-50 text-sm text-gray-900 placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-gray-900 focus:border-transparent"
                    />
                    <button
                      onClick={() => removeUnit(unit.id)}
                      disabled={units.length <= 1}
                      className="flex items-center justify-center w-8 h-8 rounded-lg text-gray-400 hover:text-gray-700 hover:bg-gray-100 transition-colors disabled:opacity-30 disabled:cursor-not-allowed"
                      title="Remove"
                    >
                      ×
                    </button>
                  </div>
                ))}
              </div>

              <button
                onClick={addUnit}
                className="mt-3 w-full py-2.5 rounded-xl border border-dashed border-gray-300 text-sm text-gray-500 hover:text-gray-700 hover:border-gray-400 transition-colors"
              >
                + Add ad unit
              </button>
            </div>

            {error && (
              <div className="bg-red-50 border border-red-200 rounded-xl px-4 py-3 text-sm text-red-700">
                {error}
              </div>
            )}

            <button
              onClick={runQA}
              disabled={
                loading ||
                !wo.trim() ||
                units.every((u) => !u.link.trim())
              }
              className="w-full py-3.5 rounded-2xl bg-gray-900 text-white text-sm font-medium hover:bg-gray-800 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
            >
              Run QA check
            </button>
          </div>
        ) : (
          /* Results */
          <div className="space-y-5">
            {/* Progressive run banner — shown while remaining campaigns finish */}
            {loading && progress.total > 0 && (
              <div className="bg-blue-50 border border-blue-200 rounded-2xl px-5 py-3 flex items-center gap-3">
                <span className="shrink-0 inline-block w-4 h-4 border-2 border-blue-300 border-t-blue-700 rounded-full animate-spin" />
                <p className="text-sm text-blue-700">
                  Checking campaigns… {progress.done} of {progress.total} done. Results appear below as each finishes.
                </p>
              </div>
            )}

            {/* Any per-campaign errors (some campaigns may fail while others succeed) */}
            {error && (
              <div className="bg-red-50 border border-red-200 rounded-2xl px-5 py-3 text-sm text-red-700">
                {error}
              </div>
            )}

            {/* Overall status */}
            <div className="bg-white rounded-2xl border border-gray-200 p-6 flex items-center justify-between">
              <div>
                <p className="text-xs font-medium tracking-widest text-gray-400 uppercase mb-1">
                  Overall result
                </p>
                <h2 className="text-xl font-semibold text-gray-900">
                  {result.overall_status === "pass"
                    ? "All clear"
                    : result.overall_status === "warning"
                    ? "Review needed"
                    : "Issues found"}
                </h2>
                {result.notes && (
                  <div className="mt-2 space-y-1.5">
                    {result.notes
                      .split(/(?<=\.)\s+(?=Promo\s+\d|Note:|Additionally,)/)
                      .map((chunk, i) => (
                        <p key={i} className="text-sm text-gray-500">{chunk.trim()}</p>
                      ))}
                  </div>
                )}
              </div>
              <StatusBadge status={result.overall_status} />
            </div>

            {/* Critical issues — consolidated: one line per shared problem,
                with the list of affected ad units, instead of repeating the
                same issue once per ad. */}
            {(() => {
              const allIssues = consolidateCriticalIssues(result.units);
              if (allIssues.length === 0) return null;

              // Split the Advantage+ AI-enhancements note. Enhancements the API
              // confirmed ON are a real finding and stay in the red Critical
              // issues card. The trailing "must be checked manually in Ads
              // Manager" reminder is the only part that moves to the small
              // yellow side note — anything that's purely manual goes yellow.
              const manualLabel = CHECK_LABELS.ai_enhancements;
              const manualRe =
                /\s*(Manual check also required|The following must (?:still )?be verified manually|API enhancement data unavailable)/i;

              const issues: ConsolidatedIssue[] = [];
              let manualNote = "";
              for (const issue of allIssues) {
                if (issue.label !== manualLabel) {
                  issues.push(issue);
                  continue;
                }
                const m = issue.detail.match(manualRe);
                if (m && m.index !== undefined) {
                  const before = issue.detail.slice(0, m.index).trim();
                  manualNote = issue.detail.slice(m.index).trim();
                  // Keep in red only if something was actually detected ON.
                  if (/\bON\b/.test(before)) {
                    issues.push({ ...issue, detail: before });
                  }
                } else {
                  // No manual tail — treat the whole thing as a finding.
                  issues.push(issue);
                }
              }

              return (
                <div className="flex flex-col gap-3 items-start">
                  {issues.length > 0 && (
                    <div className="bg-red-50 border border-red-200 rounded-2xl p-5 w-full">
                      <p className="text-sm font-semibold text-red-700 mb-2">
                        Critical issues
                      </p>
                      <ul className="space-y-2">
                        {issues.map((issue, i) => (
                          <li key={i} className="text-sm text-red-600 flex gap-2">
                            <span className="shrink-0">•</span>
                            <span>
                              <span className="font-medium">{issue.label}</span>
                              {issue.detail ? ` — ${issue.detail}` : ""}
                              <span className="block text-xs text-red-500/80 mt-0.5">
                                Affects {issue.units.length}{" "}
                                {issue.units.length === 1 ? "ad" : "ads"}:{" "}
                                {issue.units.join(", ")}
                              </span>
                            </span>
                          </li>
                        ))}
                      </ul>
                    </div>
                  )}
                  {manualNote && (
                    <div className="bg-amber-50 border border-amber-200 rounded-xl p-3 w-full">
                      <p className="text-xs font-semibold text-amber-700 mb-1">
                        Manual review
                      </p>
                      <p className="text-xs text-amber-700/90 leading-snug">
                        {manualNote}
                      </p>
                    </div>
                  )}
                </div>
              );
            })()}

            {/* Per unit cards */}
            {result.units.map((unit, i) => (
              <div
                key={i}
                className="bg-white rounded-2xl border border-gray-200 overflow-hidden"
              >
                <div className="flex items-center justify-between gap-3 px-6 py-4 border-b border-gray-100">
                  <div className="min-w-0 flex items-center gap-3">
                    <h3 className="text-sm font-semibold text-gray-900">
                      {unit.name}
                    </h3>
                    {unit.adId && <AdIdBadge adId={unit.adId} />}
                  </div>
                  <StatusBadge status={unit.status} />
                </div>
                <div className="px-6 py-2">
                  {Object.entries(unit.checks).map(([key, check]) => (
                    <CheckRow
                      key={key}
                      label={CHECK_LABELS[key] ?? key}
                      result={check}
                    />
                  ))}
                </div>
                {unit.summary && (
                  <div className="px-6 py-3 bg-gray-50 border-t border-gray-100">
                    <p className="text-xs text-gray-500">{unit.summary}</p>
                  </div>
                )}
              </div>
            ))}
          </div>
        )}
      </main>
    </div>
  );
}
