"use client";

import { useState, useEffect } from "react";

type AdUnit = {
  id: string;
  name: string;
  link: string;
};

type CheckResult = {
  status: "pass" | "fail" | "warning" | "unknown";
  note: string;
};

type UnitResult = {
  name: string;
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
  const [wo, setWo] = useState("");
  const [detectedDocs, setDetectedDocs] = useState<{ url: string; woLabel: string; content: string | null; error: string | null; loading: boolean }[]>([]);
  const [woDestinationUrl, setWoDestinationUrl] = useState<string | null>(null);
  const [units, setUnits] = useState<AdUnit[]>([
    { id: "1", name: "", link: "" },
    { id: "2", name: "", link: "" },
  ]);
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<QAResult | null>(null);
  const [error, setError] = useState("");

  // Campaign import state — supports multiple campaigns
  type CampaignRow = {
    id: string;
    campaignId: string;
    filter: string;
    loading: boolean;
    loaded: boolean;
    error: string;
  };
  const [campaigns, setCampaigns] = useState<CampaignRow[]>([
    { id: "c1", campaignId: "", filter: "", loading: false, loaded: false, error: "" },
  ]);

  function addCampaignRow() {
    setCampaigns((prev) => [
      ...prev,
      { id: String(Date.now()), campaignId: "", filter: "", loading: false, loaded: false, error: "" },
    ]);
  }

  function removeCampaignRow(id: string) {
    if (campaigns.length <= 1) {
      setCampaigns([{ id: "c1", campaignId: "", filter: "", loading: false, loaded: false, error: "" }]);
    } else {
      setCampaigns((prev) => prev.filter((c) => c.id !== id));
    }
  }

  function updateCampaignRow(id: string, field: "campaignId" | "filter", value: string) {
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
        ...toAdd.map((l) => ({ url: l.url, woLabel: l.woLabel, content: null, error: null, loading: false })),
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
          d.url === url ? { ...d, loading: false, content: data.content } : d
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
      const filtered = keyword
        ? data.ads.filter((ad: { id: string; name: string }) =>
            ad.name.toLowerCase().includes(keyword)
          )
        : data.ads;

      if (filtered.length === 0) {
        throw new Error(
          keyword
            ? `No ads matched "${row.filter.trim()}" — try a different keyword.`
            : "No ads found in this campaign."
        );
      }

      const imported: AdUnit[] = filtered.map((ad: { id: string; name: string }) => ({
        id: String(Date.now()) + ad.id,
        name: ad.name,
        link: ad.id,
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

  async function runQA() {
    if (!wo.trim()) return;
    const filledUnits = units.filter((u) => u.link.trim());
    if (filledUnits.length === 0) return;

    setLoading(true);
    setResult(null);
    setError("");

    try {
      const res = await fetch("/api/qa", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          wo,
          units: filledUnits,
          labeledDocs: detectedDocs
            .filter((d) => d.content)
            .map((d) => ({ label: d.woLabel, content: d.content })),
          destinationUrl: woDestinationUrl ?? null,
        }),
      });

      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.error ?? "QA check failed");
      }

      const data = await res.json();
      setResult(data);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong");
    } finally {
      setLoading(false);
    }
  }

  function reset() {
    setResult(null);
    setError("");
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
          <img src="/vera-wordmark-transparent.png" alt="Vera" className="h-20" />
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
        {loading ? (
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
        ) : !result ? (
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
                            ✓ Loaded — {doc.content.length.toLocaleString()} chars read into QA
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
                <div className="grid grid-cols-[1fr_auto_auto_32px] gap-2 px-1 mb-1">
                  <span className="text-xs font-medium text-gray-400 uppercase tracking-wide">Campaign ID</span>
                  <span className="text-xs font-medium text-gray-400 uppercase tracking-wide w-40">Filter (optional)</span>
                  <span />
                  <span />
                </div>

                {campaigns.map((row) => (
                  <div key={row.id} className="space-y-1">
                    <div className="grid grid-cols-[1fr_auto_auto_32px] gap-2 items-center">
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

            {/* Critical issues */}
            {result.critical_issues.length > 0 && (
              <div className="bg-red-50 border border-red-200 rounded-2xl p-5">
                <p className="text-sm font-semibold text-red-700 mb-2">
                  Critical issues
                </p>
                <ul className="space-y-1">
                  {result.critical_issues.map((issue, i) => (
                    <li key={i} className="text-sm text-red-600 flex gap-2">
                      <span className="shrink-0">•</span>
                      {issue}
                    </li>
                  ))}
                </ul>
              </div>
            )}

            {/* Per unit cards */}
            {result.units.map((unit, i) => (
              <div
                key={i}
                className="bg-white rounded-2xl border border-gray-200 overflow-hidden"
              >
                <div className="flex items-center justify-between px-6 py-4 border-b border-gray-100">
                  <h3 className="text-sm font-semibold text-gray-900">
                    {unit.name}
                  </h3>
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
