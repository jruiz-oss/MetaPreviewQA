"use client";

import { useState, useEffect, useRef } from "react";
import { useRouter } from "next/navigation";


type AdUnit = {
  id: string;
  name: string;
  link: string;
  // Which campaign this unit was imported from. Manually-typed units have none
  // and are grouped together. Used to send one QA request per campaign.
  campaignId?: string;
  // Human-readable campaign name resolved from the Meta API — shown alongside
  // the campaign ID in the UI. Manual units: none.
  campaignName?: string;
  // Ad set name from the Meta API. Lets the QA route scope approved Drive
  // images to the right ad set when approval subfolders are named after ad
  // sets (e.g. "Walnut Creek/" ↔ the Walnut Creek ad set). Manual units: none.
  adsetName?: string;
  // Ad set ID from the Meta API — shown alongside the ad set name in the UI.
  adsetId?: string;
};

type DriveImage = {
  id: string;
  name: string;
  mediaType: string;
};

type CheckResult = {
  status: "pass" | "fail" | "warning" | "unknown";
  note: string;
  text_in_approved?: string | null;
  text_in_live?: string | null;
};

// Identical ad versions are QA'd once and reported as a single result. `group`
// lists every ad unit (name + ad ID) that shares this result; for a one-off ad
// it's just the ad itself. Units that differ on any checked field have a
// different fingerprint server-side, so they arrive as their own UnitResult.
type GroupMember = { name: string; adId?: string | null };

type UnitResult = {
  name: string;
  adId?: string | null;
  status: "pass" | "fail" | "warning";
  checks: {
    copy_alignment: CheckResult;
    creative_alignment: CheckResult;
    promo_month_date: CheckResult;
    url_cta: CheckResult;
    grammar_typos: CheckResult;
    ai_enhancements: CheckResult;
    format_size: CheckResult;
  };
  summary: string;
  group?: GroupMember[];
  groupSize?: number;
  // Image sizes + carousel flag from the server, for the cross-ad size
  // comparison run after all chunks finish (campaigns are QA'd in chunks, so
  // only the browser ever sees every ad of a campaign together).
  sizeProfile?: { isCarousel: boolean; imageSizes: string[] };
  // Which campaign this result belongs to — tagged client-side on merge so the
  // cross-ad comparison never compares ads from different campaigns.
  campaignKey?: string;
};

type QAResult = {
  overall_status: "pass" | "fail" | "warning";
  units: UnitResult[];
  critical_issues: string[];
  notes: string;
};

const CHECK_LABELS: Record<string, string> = {
  copy_alignment: "Copy match",
  creative_alignment: "Creative match",
  promo_month_date: "Promo month & dates",
  url_cta: "URL & CTA destination",
  grammar_typos: "Grammar & typos",
  ai_enhancements: "Advantage+ AI enhancements",
  format_size: "Format & size",
};

// Order in which consolidated critical issues are grouped/scanned.
const CRITICAL_ORDER = [
  "copy_alignment",
  "creative_alignment",
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
    // A consolidated result covers every ad in its group — count them all so
    // "affects N ads" reflects the real ad count, not the representative alone.
    const names =
      unit.group && unit.group.length
        ? unit.group.map((m) => m.name || "Unnamed")
        : [unit.name || "Unnamed"];
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
      for (const name of names) if (!b.units.includes(name)) b.units.push(name);
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

// How a check renders in the per-unit card. The Advantage+ AI-enhancements
// check is special: the Meta API can't confirm those toggles, so the server
// always returns it as "warning" with a manual-verification note. When nothing
// was actually detected ON, that's not a real warning — render it as a neutral
// N/A with a short manual reminder so a clean ad doesn't show a perpetual amber
// card. When something IS ON, keep it amber (a genuine finding) and drop the
// manual tail.
const MANUAL_TAIL_RE =
  /\s*(Manual check also required|The following must (?:still )?be verified manually|API enhancement data unavailable)[\s\S]*/i;
function displayCheckResult(key: string, check: CheckResult): CheckResult {
  if (key !== "ai_enhancements" || !check.note) return check;
  const hasOnFinding = /\bON\b/.test(check.note);
  const cleaned = check.note.replace(MANUAL_TAIL_RE, "").trim();
  if (hasOnFinding) return { ...check, status: "warning", note: cleaned };
  return {
    ...check,
    status: "unknown",
    note: "Verify Advantage+ AI enhancements manually in Ads Manager.",
  };
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
    <span className={`pdf-badge text-xs font-medium px-2.5 py-1 rounded-full leading-none ${styles[status] ?? styles.unknown}`}>
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
      className="pdf-badge group inline-flex items-center gap-1.5 rounded-md bg-gray-100 px-2 py-0.5 font-mono text-xs text-gray-600 hover:bg-gray-200 select-all"
    >
      <span>{adId}</span>
      <span className="text-gray-400 group-hover:text-gray-600 select-none">
        {copied ? "✓" : "⧉"}
      </span>
    </button>
  );
}

function CheckCard({ label, result }: { label: string; result: CheckResult }) {
  // Fails and warnings start open; passes start collapsed.
  const defaultOpen = result.status === "fail" || result.status === "warning";
  const [open, setOpen] = useState(defaultOpen);

  const hasImageText = result.text_in_approved != null || result.text_in_live != null;

  const borderColor: Record<string, string> = {
    pass: "border-emerald-200",
    fail: "border-red-200",
    warning: "border-amber-200",
    unknown: "border-gray-200",
  };
  const headerBg: Record<string, string> = {
    pass: "bg-emerald-50",
    fail: "bg-red-50",
    warning: "bg-amber-50",
    unknown: "bg-gray-50",
  };
  const iconColor: Record<string, string> = {
    pass: "text-emerald-600",
    fail: "text-red-600",
    warning: "text-amber-600",
    unknown: "text-gray-400",
  };
  const icons: Record<string, string> = {
    pass: "✓",
    fail: "✗",
    warning: "!",
    unknown: "–",
  };

  const s = result.status in borderColor ? result.status : "unknown";

  return (
    <div className={`rounded-xl border ${borderColor[s]} overflow-hidden`}>
      {/* Accordion header — always visible */}
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className={`w-full flex items-center justify-between gap-3 px-4 py-2.5 ${headerBg[s]} text-left`}
      >
        <div className="flex items-center gap-2">
          <span className={`font-semibold text-sm ${iconColor[s]}`}>
            {icons[s]}
          </span>
          <span className="text-sm font-medium text-gray-800">{label}</span>
        </div>
        <span className="text-gray-400 text-xs select-none">{open ? "▲" : "▼"}</span>
      </button>

      {/* Accordion body */}
      {open && (result.note || hasImageText) && (
        <div className="px-4 py-3 bg-white border-t border-gray-100 space-y-2">
          {result.note && (
            <p className="text-sm text-gray-600">{result.note}</p>
          )}
          {hasImageText && (
            <details className="mt-1">
              <summary className="text-xs text-gray-400 cursor-pointer hover:text-gray-600 select-none">
                Image text extracted
              </summary>
              <div className="mt-1.5 grid grid-cols-2 gap-2 text-xs">
                <div className="rounded bg-gray-50 border border-gray-200 p-2">
                  <p className="font-medium text-gray-500 mb-1">Approved (Drive)</p>
                  <p className="text-gray-700 whitespace-pre-wrap">{result.text_in_approved ?? "—"}</p>
                </div>
                <div className="rounded bg-gray-50 border border-gray-200 p-2">
                  <p className="font-medium text-gray-500 mb-1">Live (Meta)</p>
                  <p className="text-gray-700 whitespace-pre-wrap">{result.text_in_live ?? "—"}</p>
                </div>
              </div>
            </details>
          )}
        </div>
      )}
    </div>
  );
}

// Coerce an API `error` payload to a readable string. Some failure paths hand
// back an error OBJECT (e.g. a platform-level JSON error body) instead of a
// string; `new Error(obj)` then renders the useless "[object Object]" in the
// UI. JSON-stringify anything that isn't already a string so the real cause
// is visible.
function asErrorMessage(v: unknown, fallback: string): string {
  if (typeof v === "string" && v.trim()) return v;
  if (v == null) return fallback;
  try {
    return `${fallback} — ${JSON.stringify(v)}`;
  } catch {
    return fallback;
  }
}

export default function QAPage() {
  const router = useRouter();
  const [wo, setWo] = useState("");
  const [ignoreCopyDoc, setIgnoreCopyDoc] = useState(false);
  const [instructions, setInstructions] = useState("");
  const [detectedDocs, setDetectedDocs] = useState<{ url: string; woLabel: string; content: string | null; images: DriveImage[]; error: string | null; loading: boolean }[]>([]);
  const [woDestinationUrl, setWoDestinationUrl] = useState<string | null>(null);
  const [units, setUnits] = useState<AdUnit[]>([]);
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<QAResult | null>(null);
  const [error, setError] = useState("");
  // Progress across per-campaign QA requests (done / total campaigns).
  const [progress, setProgress] = useState<{ done: number; total: number }>({ done: 0, total: 0 });
  // PDF export: ref wraps the results block we capture; flag drives button state.
  const resultsRef = useRef<HTMLDivElement>(null);
  const [downloadingPdf, setDownloadingPdf] = useState(false);


  // Campaign import state — supports multiple campaigns
  type ActiveRule = { id: string; name: string; summary: string };

  type CampaignRow = {
    id: string;
    campaignId: string;
    campaignName: string; // resolved from Meta on load — shown next to the ID
    filter: string;
    sinceDate: string;   // optional YYYY-MM-DD updated-since cutoff
    loading: boolean;
    loaded: boolean;
    cooldown: boolean;   // true for 60s after an error to prevent rapid retries
    error: string;
    skipNote: string;    // post-load summary of what was filtered out
    activeRules: ActiveRule[]; // automation rules that are currently ENABLED
  };
  // Default the updated-since cutoff to ~30 days ago. We never QA old ads through
  // Vera, so pre-filling this means one less field to think about — the user can
  // still change or clear it for the rare backfill case. The filter runs on
  // Meta's updated_time so ads EDITED for the current promo are kept even if
  // they were created months ago.
  function defaultSinceDate(): string {
    const d = new Date();
    d.setDate(d.getDate() - 30);
    return d.toISOString().slice(0, 10); // YYYY-MM-DD
  }
  const newCampaignRow = (id: string): CampaignRow => ({
    id,
    campaignId: "",
    campaignName: "",
    filter: "",
    sinceDate: defaultSinceDate(),
    loading: false,
    loaded: false,
    cooldown: false,
    error: "",
    skipNote: "",
    activeRules: [],
  });
  const [campaigns, setCampaigns] = useState<CampaignRow[]>([newCampaignRow("c1")]);

  function addCampaignRow() {
    setCampaigns((prev) => [...prev, newCampaignRow(String(Date.now()))]);
  }

  function removeCampaignRow(id: string) {
    if (campaigns.length <= 1) {
      setCampaigns([newCampaignRow("c1")]);
    } else {
      setCampaigns((prev) => prev.filter((c) => c.id !== id));
    }
  }

  function patchCampaignRow(id: string, patch: Partial<CampaignRow>) {
    setCampaigns((prev) =>
      prev.map((c) =>
        c.id === id ? { ...c, ...patch, error: "", loaded: false, skipNote: "", campaignName: "" } : c
      )
    );
  }

  function updateCampaignRow(
    id: string,
    field: "campaignId" | "filter",
    value: string
  ) {
    patchCampaignRow(id, { [field]: value } as Partial<CampaignRow>);
  }

  // Drop a single ad from the loaded set (ads are loaded via Campaign ID import).
  function removeUnit(id: string) {
    setUnits((prev) => prev.filter((u) => u.id !== id));
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
      if (!res.ok) throw new Error(asErrorMessage(data.error, `Failed to fetch doc (HTTP ${res.status})`));
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
        body: JSON.stringify({
          campaignId: row.campaignId.trim(),
          sinceDate: row.sinceDate.trim() || undefined,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(asErrorMessage(data.error, `Failed to load campaign ads (HTTP ${res.status})`));

      const campaignName: string = data.campaignName ?? "";
      const keyword = row.filter.trim().toLowerCase();
      const filtered = keyword
        ? data.ads.filter((ad: { id: string; name: string; adsetName?: string }) => {
            const adMatch = ad.name.toLowerCase().includes(keyword);
            const adsetMatch = (ad.adsetName ?? "").toLowerCase().includes(keyword);
            return adMatch || adsetMatch;
          })
        : data.ads;

      if (filtered.length === 0) {
        throw new Error(
          keyword
            ? `No ads matched "${row.filter.trim()}" in ad or ad set name — try a different keyword.`
            : "No ads found in this campaign."
        );
      }

      const importedCampaignId = row.campaignId.trim();
      const imported: AdUnit[] = filtered.map((ad: { id: string; name: string; adsetName?: string; adsetId?: string }) => ({
        id: String(Date.now()) + ad.id,
        name: ad.name,
        link: ad.id,
        campaignId: importedCampaignId,
        campaignName: campaignName || undefined,
        adsetName: ad.adsetName || undefined,
        adsetId: ad.adsetId || undefined,
      }));

      // Append to existing units (remove empty placeholder rows first)
      setUnits((prev) => {
        const nonEmpty = prev.filter((u) => u.link.trim() || u.name.trim());
        return nonEmpty.length > 0 ? [...nonEmpty, ...imported] : imported;
      });

      const skippedOld = data.skippedOld ?? 0;
      const skipNote =
        `Loaded ${imported.length} ad${imported.length === 1 ? "" : "s"}` +
        (campaignName ? ` from "${campaignName}"` : "") +
        (skippedOld > 0 ? ` · skipped ${skippedOld} not updated since cutoff` : "");

      const activeRules: ActiveRule[] = data.activeRules ?? [];

      setCampaigns((prev) =>
        prev.map((c) => (c.id === rowId ? { ...c, loading: false, loaded: true, skipNote, campaignName, activeRules } : c))
      );
    } catch (err) {
      setCampaigns((prev) =>
        prev.map((c) =>
          c.id === rowId
            ? { ...c, loading: false, cooldown: true, error: err instanceof Error ? err.message : "Something went wrong" }
            : c
        )
      );
      // Re-enable after 60s so the user can retry without hammering the Meta API
      setTimeout(() => {
        setCampaigns((prev) =>
          prev.map((c) => (c.id === rowId ? { ...c, cooldown: false } : c))
        );
      }, 60_000);
    }
  }

  // Rank used to roll individual unit statuses up into an overall status.
  function statusRank(s: string): number {
    return s === "fail" ? 2 : s === "warning" ? 1 : 0;
  }

  // ── Cross-ad size comparison ───────────────────────────────────────────────
  // Within ONE campaign, ads of the same format should share creative sizes:
  // all statics one size, all carousels one size (V1 vs V2 included). Carousels
  // and statics are compared separately — a 920×920 static next to 1080×1080
  // carousels is fine. Sizes are compared per aspect ratio so legit placement
  // variants (1:1 + 9:16) never collide; only same-ratio different-pixel sizes
  // across ads get flagged (e.g. V1 static 1080×1080 vs V2 static 920×920).
  // Runs once, after every chunk's results are merged — warning-level only.
  function applyCrossAdSizeCheck(result: QAResult): QAResult {
    const units = result.units.map((u) => ({ ...u, checks: { ...u.checks, format_size: { ...u.checks.format_size } } }));

    // campaign → format (carousel|static) → ratio → size → unit indices
    const byCampaign = new Map<string, number[]>();
    units.forEach((u, i) => {
      if (!u.sizeProfile?.imageSizes?.length) return;
      const key = u.campaignKey ?? "__manual__";
      if (!byCampaign.has(key)) byCampaign.set(key, []);
      byCampaign.get(key)!.push(i);
    });

    const ratioOf = (size: string): string | null => {
      const [w, h] = size.split("×").map(Number);
      return w > 0 && h > 0 ? (w / h).toFixed(2) : null;
    };

    for (const idxs of Array.from(byCampaign.values())) {
      for (const wantCarousel of [true, false]) {
        const groupIdxs = idxs.filter((i) => units[i].sizeProfile!.isCarousel === wantCarousel);
        if (groupIdxs.length < 2) continue;

        // ratio → size → set of unit indices using that size
        const ratioMap = new Map<string, Map<string, Set<number>>>();
        for (const i of groupIdxs) {
          for (const size of Array.from(new Set(units[i].sizeProfile!.imageSizes))) {
            const r = ratioOf(size);
            if (!r) continue;
            if (!ratioMap.has(r)) ratioMap.set(r, new Map());
            const sizeMap = ratioMap.get(r)!;
            if (!sizeMap.has(size)) sizeMap.set(size, new Set());
            sizeMap.get(size)!.add(i);
          }
        }

        const fmtLabel = wantCarousel ? "carousel" : "static";
        const flagUnit = (i: number, note: string) => {
          const u = units[i];
          const fs = u.checks.format_size;
          fs.note = fs.note ? `${fs.note} ${note}` : note;
          if (fs.status === "pass" || fs.status === "unknown") fs.status = "warning";
          if (u.status === "pass") u.status = "warning";
        };
        for (const sizeMap of Array.from(ratioMap.values())) {
          if (sizeMap.size < 2) continue; // one size for this ratio → consistent
          const ranked = Array.from(sizeMap.entries()).sort((a, b) => b[1].size - a[1].size);
          // TIE for the top count (e.g. 1 ad vs 1 ad): there is no majority, so
          // electing an "outlier" would be arbitrary — flag ALL involved units
          // with a neutral note instead of blaming one side at random.
          const isTie = ranked.length > 1 && ranked[1][1].size === ranked[0][1].size;
          if (isTie) {
            const sizesDesc = ranked.map(([s, set]) => `${s} (${set.size} ad(s))`).join(" vs ");
            const flagged = new Set<number>();
            for (const [, set] of ranked) for (const i of Array.from(set)) flagged.add(i);
            for (const i of Array.from(flagged)) {
              flagUnit(
                i,
                `Cross-ad check: same-format ${fmtLabel} ads in this campaign use different sizes (${sizesDesc}) — same-format ads should share one size; verify which is correct.`
              );
            }
            continue;
          }
          // Clear majority: everyone else is an outlier. Skip units that also
          // carry the majority size (already covered by the per-ad mixed-size
          // rule — don't let a unit flag itself).
          const [majSize, majUnits] = ranked[0];
          for (const [size, unitSet] of ranked.slice(1)) {
            for (const i of Array.from(unitSet)) {
              if (majUnits.has(i)) continue;
              flagUnit(
                i,
                `Cross-ad check: this ${fmtLabel} uses ${size} while ${majUnits.size} other ${fmtLabel} ad(s) in the campaign use ${majSize} — same-format ads should share one size.`
              );
            }
          }
        }
      }
    }

    const worst = units.reduce(
      (w, u) => (statusRank(u.status) > statusRank(w) ? u.status : w),
      "pass" as QAResult["overall_status"]
    );
    return { ...result, units, overall_status: worst };
  }

  async function runQA() {
    if (!wo.trim()) return;
    const filledUnits = units.filter((u) => u.link.trim());
    if (filledUnits.length === 0) return;

    // Split units into small fixed-size chunks. A whole campaign (e.g. 17+ ad
    // units) in one /api/qa request makes the server run that many Claude calls
    // at concurrency 2 inside a single function — which blows past Vercel's 300s
    // limit and returns 504. Chunking to a few units keeps each request to a
    // handful of Claude calls (~20-60s), safely under the limit, and lets
    // results stream in chunk-by-chunk. Units are grouped by campaign first so a
    // chunk's units share an origin (keeps within-chunk dedup meaningful) and the
    // label stays readable.
    const CHUNK_SIZE = 3;
    const byCampaign = new Map<string, AdUnit[]>();
    for (const u of filledUnits) {
      const key = u.campaignId ?? "__manual__";
      if (!byCampaign.has(key)) byCampaign.set(key, []);
      byCampaign.get(key)!.push(u);
    }
    const groups: { key: string; label: string; units: AdUnit[] }[] = [];
    for (const [key, us] of Array.from(byCampaign.entries())) {
      const campaignLabel = key === "__manual__" ? "Manually added units" : `Campaign ${key}`;
      const chunkCount = Math.ceil(us.length / CHUNK_SIZE);
      for (let c = 0; c < chunkCount; c++) {
        const chunk = us.slice(c * CHUNK_SIZE, (c + 1) * CHUNK_SIZE);
        groups.push({
          key: `${key}#${c}`,
          label: chunkCount > 1 ? `${campaignLabel} (part ${c + 1}/${chunkCount})` : campaignLabel,
          units: chunk,
        });
      }
    }

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
            labeledDocs: ignoreCopyDoc
              ? labeledDocs.filter((d) => !d.label.toUpperCase().includes("COPY"))
              : labeledDocs,
            driveImages,
            destinationUrl: woDestinationUrl ?? null,
            ignoreCopyDoc,
            instructions: instructions.trim() || undefined,
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
          throw new Error(asErrorMessage(data.error, `${group.label}: QA check failed (HTTP ${res.status})`));
        }

        const partial = data as unknown as QAResult;
        // Tag each unit with its campaign (group.key is "<campaignId>#<chunk>")
        // so the post-run cross-ad size check only compares within a campaign.
        const campaignKey = group.key.split("#")[0];
        const taggedUnits = (partial.units ?? []).map((u) => ({ ...u, campaignKey }));
        // Merge this campaign's results into the accumulating result as soon as
        // it returns, so the user sees results stream in rather than waiting.
        setResult((prev) => {
          const base = prev ?? { overall_status: "pass" as QAResult["overall_status"], units: [], critical_issues: [], notes: "" };
          const mergedUnits = [...base.units, ...taggedUnits];
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

    // All chunks merged — run the cross-ad size comparison over the full set.
    setResult((prev) => (prev ? applyCrossAdSizeCheck(prev) : prev));

    if (errors.length > 0) setError(errors.join("  "));
    setLoading(false);
  }

  // Derive a filename-safe WO identifier from the pasted WO text. Looks for an
  // explicit work-order number ("WO #1234", "WO-1234", "Work Order 1234", "WO1234")
  // first; otherwise falls back to the first non-empty line (e.g. campaign name),
  // truncated. Returns "" if nothing usable is found.
  function woFileSlug(text: string): string {
    if (!text) return "";
    const num = text.match(/\b(?:w\.?o\.?|work\s*order|job)\b[\s#:.-]*([a-z0-9][a-z0-9-]{1,20})/i);
    let raw = num ? `WO-${num[1]}` : "";
    if (!raw) {
      const firstLine = text.split(/\r?\n/).map((l) => l.trim()).find(Boolean) ?? "";
      raw = firstLine.slice(0, 40);
    }
    return raw
      .replace(/https?:\/\/\S+/g, "")
      .replace(/[^a-z0-9]+/gi, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 40);
  }

  // Print the results block as a PDF using the browser's native print dialog.
  // This gives crisp vector text and avoids html2canvas spacing/rendering bugs.
  async function downloadPdf() {
    if (!resultsRef.current || downloadingPdf) return;
    setDownloadingPdf(true);

    const PRINT_ID = "vera-print-root";
    resultsRef.current.id = PRINT_ID;

    const style = document.createElement("style");
    style.id = "vera-print-css";
    style.textContent = `
      @media print {
        /* Hide all page chrome; show only the results block */
        body * { visibility: hidden !important; }
        #${PRINT_ID}, #${PRINT_ID} * { visibility: visible !important; }
        /* absolute (not fixed!) — fixed elements clip to a single printed page */
        #${PRINT_ID} {
          position: absolute !important;
          top: 0 !important;
          left: 0 !important;
          width: 100% !important;
          height: auto !important;
          overflow: visible !important;
        }

        /* Let the document grow to the full content height across pages */
        html, body {
          height: auto !important;
          overflow: visible !important;
        }

        @page {
          size: A4 portrait;
          margin: 1.4cm 1.8cm;
        }

        /* Preserve background colors (badges, status pills, card tints) */
        * {
          -webkit-print-color-adjust: exact !important;
          print-color-adjust: exact !important;
        }

        /* Avoid clipping card contents at page boundaries */
        .vera-unit-card {
          break-inside: avoid;
          page-break-inside: avoid;
          overflow: visible !important;
        }

        /* Badge / pill rendering — keep inline-block so text sits flush */
        .pdf-badge {
          display: inline-block !important;
          line-height: 1.6 !important;
          vertical-align: middle !important;
        }

        /* Hide interactive-only elements */
        button.pdf-badge > span:last-child { display: none !important; }

        /* Collapse flex gaps that sometimes print as 0 */
        .gap-3 { gap: 0.75rem !important; }
        .gap-2 { gap: 0.5rem !important; }
        .gap-1\\.5 { gap: 0.375rem !important; }
      }
    `;
    document.head.appendChild(style);

    // Brief delay so React flushes any pending renders before the print snapshot.
    await new Promise((r) => setTimeout(r, 80));

    window.print();

    // Cleanup — runs after the print dialog closes.
    style.remove();
    if (resultsRef.current) resultsRef.current.id = "";
    setDownloadingPdf(false);
  }

  function reset() {
    // Full clear of all input boxes — stays logged in (no auth touched)
    setWo("");
    setDetectedDocs([]);
    setWoDestinationUrl(null);
    setUnits([]);
    setCampaigns([newCampaignRow("c1")]);
    setResult(null);
    setError("");
    setProgress({ done: 0, total: 0 });
    setInstructions("");
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

  // Ad ID → loaded AdUnit, so result cards can show the campaign / ad set
  // names + IDs that came with the import (results themselves only carry the
  // ad name + ID).
  const unitMetaByAdId = new Map(
    units.filter((u) => u.link.trim()).map((u) => [u.link.trim(), u])
  );

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
        <div className="flex items-center gap-4">
          {result && (
            <button
              onClick={reset}
              className="text-sm text-gray-500 hover:text-gray-900 transition-colors"
            >
              ← New check
            </button>
          )}
        </div>
      </header>


      <main className="max-w-3xl mx-auto px-6 py-8">
        {loading ? (
          /* ── QA Running Animation ─────────────────────────── */
          /* Stays up for the ENTIRE run (all campaigns) so partial results
             never render as a finished-looking verdict. Results appear all at
             once when loading flips false. */
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
              {progress.total > 0 && (
                <p className="text-sm font-semibold text-gray-700">
                  {progress.done} of {progress.total} campaigns done
                </p>
              )}
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
                className="w-full px-4 py-3 rounded-xl border border-gray-200 bg-gray-50 text-sm text-gray-900 placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-gray-900 focus:border-transparent resize-y min-h-[144px]"
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
                  Paste a <strong>Campaign ID</strong> to auto-load all its ads.
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
                        disabled={row.loading || row.loaded || row.cooldown || !row.campaignId.trim()}
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
                        ) : row.cooldown ? (
                          "Wait 60s..."
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
                    {/* Optional updated-since cutoff. Set this to the start of the
                        current promo so reused campaigns don't pull stale ad sets
                        from past months into the QA run. Runs on updated_time so
                        ads edited in place for this promo are kept. */}
                    <div className="flex items-center flex-wrap gap-x-4 gap-y-1.5 pl-1">
                      <label className="inline-flex items-center gap-1.5 text-xs text-gray-600 select-none">
                        Only ads updated since
                        <input
                          type="date"
                          value={row.sinceDate}
                          onChange={(e) =>
                            patchCampaignRow(row.id, { sinceDate: e.target.value })
                          }
                          className="px-2 py-1 rounded-lg border border-gray-200 bg-gray-50 text-xs text-gray-900 focus:outline-none focus:ring-2 focus:ring-gray-900 focus:border-transparent"
                        />
                        {row.sinceDate && (
                          <button
                            type="button"
                            onClick={() => patchCampaignRow(row.id, { sinceDate: "" })}
                            className="text-gray-400 hover:text-gray-700"
                            title="Clear date"
                          >
                            ×
                          </button>
                        )}
                      </label>
                    </div>
                    {row.skipNote && !row.error && (
                      <p className="text-xs text-emerald-700 pl-1">{row.skipNote}</p>
                    )}
                    {row.error && (
                      <p className="text-xs text-red-600 pl-1">{row.error}</p>
                    )}
                    {row.activeRules.length > 0 && (
                      <div className="mt-1.5 rounded-xl border border-amber-300 bg-amber-50 px-3 py-2.5 space-y-1.5">
                        <p className="text-xs font-semibold text-amber-800">
                          ⚠ {row.activeRules.length} active automation rule{row.activeRules.length === 1 ? "" : "s"} on this campaign
                        </p>
                        {row.activeRules.map((rule) => (
                          <div key={rule.id} className="text-xs text-amber-700 leading-snug">
                            <span className="font-medium">{rule.name}</span>
                            {rule.summary ? <span className="text-amber-600"> — {rule.summary}</span> : null}
                          </div>
                        ))}
                        <p className="text-xs text-amber-600 mt-0.5">
                          Check that none of these will pause or modify the campaign unexpectedly.
                        </p>
                      </div>
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

              {/* Loaded ads preview */}
              {units.some((u) => u.link.trim()) && (
                <div className="space-y-2">
                  <p className="text-xs font-medium text-gray-400 uppercase tracking-wide px-1">
                    Loaded ads ({units.filter((u) => u.link.trim()).length})
                  </p>
                  {units
                    .filter((u) => u.link.trim())
                    .map((unit) => (
                      <div
                        key={unit.id}
                        className="flex items-center justify-between gap-3 px-3 py-2.5 rounded-xl border border-gray-200 bg-gray-50"
                      >
                        <div className="min-w-0">
                          <p className="text-sm text-gray-900 truncate">{unit.name || "Unnamed ad"}</p>
                          <p className="text-xs font-mono text-gray-400 truncate">{unit.link}</p>
                          {(unit.adsetName || unit.adsetId) && (
                            <p className="text-xs text-gray-500 truncate">
                              Ad set: {unit.adsetName || "—"}
                              {unit.adsetId && <span className="font-mono text-gray-400"> · {unit.adsetId}</span>}
                            </p>
                          )}
                          {(unit.campaignName || unit.campaignId) && (
                            <p className="text-xs text-gray-500 truncate">
                              Campaign: {unit.campaignName || "—"}
                              {unit.campaignId && <span className="font-mono text-gray-400"> · {unit.campaignId}</span>}
                            </p>
                          )}
                        </div>
                        <button
                          onClick={() => removeUnit(unit.id)}
                          className="shrink-0 flex items-center justify-center w-8 h-8 rounded-lg text-gray-400 hover:text-gray-700 hover:bg-gray-100 transition-colors"
                          title="Remove"
                        >
                          ×
                        </button>
                      </div>
                    ))}
                </div>
              )}
            </div>

            {error && (
              <div className="bg-red-50 border border-red-200 rounded-xl px-4 py-3 text-sm text-red-700">
                {error}
              </div>
            )}

            {/* Ignore copy doc toggle */}
            <label className="flex items-center justify-between gap-3 px-4 py-3 rounded-xl border border-gray-200 bg-gray-50 cursor-pointer select-none">
              <div>
                <p className="text-sm font-medium text-gray-800">Use WO copy only</p>
                <p className="text-xs text-gray-500 mt-0.5">Ignore the copy doc — evaluate copy against the work order text only</p>
              </div>
              <button
                type="button"
                role="switch"
                aria-checked={ignoreCopyDoc}
                onClick={() => setIgnoreCopyDoc((v) => !v)}
                className={`relative inline-flex h-6 w-11 shrink-0 rounded-full border-2 border-transparent transition-colors focus:outline-none ${ignoreCopyDoc ? "bg-gray-900" : "bg-gray-300"}`}
              >
                <span
                  className={`inline-block h-5 w-5 rounded-full bg-white shadow transform transition-transform ${ignoreCopyDoc ? "translate-x-5" : "translate-x-0"}`}
                />
              </button>
            </label>

            {/* Optional reviewer instructions */}
            <details className="group">
              <summary className="flex items-center justify-between gap-3 px-4 py-3 rounded-xl border border-gray-200 bg-gray-50 cursor-pointer select-none list-none">
                <div>
                  <p className="text-sm font-medium text-gray-800">Reviewer instructions <span className="text-gray-400 font-normal">(optional)</span></p>
                  <p className="text-xs text-gray-500 mt-0.5">Add focus or context to the audit — e.g. "the resort name is spelled 'Tahoe'", "double-check the disclaimer copy". Notes add to the QA; they don't skip checks.</p>
                </div>
                <span className="text-gray-400 text-xs shrink-0 group-open:rotate-180 transition-transform">▼</span>
              </summary>
              <div className="mt-2">
                <textarea
                  value={instructions}
                  onChange={(e) => setInstructions(e.target.value)}
                  rows={3}
                  placeholder={"e.g. The resort name is correctly spelled 'Tahoe' — flag anything else.\nThe summer promo runs through August, so August dates are current.\nThe carousel cards intentionally deep-link to different pages."}
                  className="w-full px-4 py-3 rounded-xl border border-gray-200 bg-gray-50 text-sm text-gray-900 placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-gray-900 focus:border-transparent resize-y min-h-[88px]"
                />
              </div>
            </details>

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
            {/* Any per-campaign errors (some campaigns may fail while others succeed) */}
            {error && (
              <div className="bg-red-50 border border-red-200 rounded-2xl px-5 py-3 text-sm text-red-700">
                {error}
              </div>
            )}

            {/* Top bar — download the whole results view as a PDF to share. */}
            <div className="flex items-center justify-between">
              <p className="text-xs font-medium tracking-widest text-gray-400 uppercase">
                QA results
              </p>
              <button
                onClick={downloadPdf}
                disabled={downloadingPdf || loading}
                className="inline-flex items-center gap-2 px-4 py-2 rounded-xl bg-gray-900 text-white text-sm font-medium hover:bg-gray-800 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
                title={loading ? "Wait for all campaigns to finish" : "Print / save results as PDF"}
              >
                {downloadingPdf ? (
                  <>
                    <span className="inline-block w-3.5 h-3.5 border-2 border-white/30 border-t-white rounded-full animate-spin" />
                    Preparing…
                  </>
                ) : (
                  <>
                    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
                      <polyline points="7 10 12 15 17 10" />
                      <line x1="12" y1="15" x2="12" y2="3" />
                    </svg>
                    Download PDF
                  </>
                )}
              </button>
            </div>

            {/* Everything inside this wrapper is captured into the PDF. */}
            <div ref={resultsRef} className="space-y-5">

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
                className="vera-unit-card bg-white rounded-2xl border border-gray-200 overflow-hidden"
              >
                {(() => {
                  // The result may cover several identical ad versions. Show the
                  // name once, then a badge per ad ID it applies to. A single ad
                  // falls back to its own name + ID.
                  const members =
                    unit.group && unit.group.length
                      ? unit.group
                      : [{ name: unit.name, adId: unit.adId }];
                  const grouped = members.length > 1;
                  return (
                    <div className="flex items-start justify-between gap-3 px-6 py-4 border-b border-gray-100">
                      <div className="min-w-0">
                        <div className="flex items-center gap-2 flex-wrap">
                          <h3 className="text-sm font-semibold text-gray-900">
                            {unit.name}
                          </h3>
                          {grouped && (
                            <span className="pdf-badge text-xs font-medium text-gray-500 bg-gray-100 rounded-full px-2.5 py-1 leading-none">
                              ×{members.length} identical ads
                            </span>
                          )}
                        </div>
                        <div className="flex items-center gap-1.5 flex-wrap mt-1.5">
                          {members
                            .filter((m) => m.adId)
                            .map((m) => (
                              <AdIdBadge key={m.adId} adId={m.adId as string} />
                            ))}
                        </div>
                        {(() => {
                          // Campaign / ad set context (name + ID), deduped in
                          // case a grouped result spans several identical ads.
                          const metas = members
                            .map((m) => (m.adId ? unitMetaByAdId.get(m.adId) : undefined))
                            .filter((m): m is AdUnit => !!m);
                          const adsetLines = Array.from(
                            new Set(
                              metas
                                .filter((m) => m.adsetName || m.adsetId)
                                .map((m) => `${m.adsetName || "—"}${m.adsetId ? ` (${m.adsetId})` : ""}`)
                            )
                          );
                          const campaignLines = Array.from(
                            new Set(
                              metas
                                .filter((m) => m.campaignName || m.campaignId)
                                .map((m) => `${m.campaignName || "—"}${m.campaignId ? ` (${m.campaignId})` : ""}`)
                            )
                          );
                          if (!adsetLines.length && !campaignLines.length) return null;
                          return (
                            <div className="mt-1.5 space-y-0.5">
                              {adsetLines.length > 0 && (
                                <p className="text-xs text-gray-500">Ad set: {adsetLines.join(", ")}</p>
                              )}
                              {campaignLines.length > 0 && (
                                <p className="text-xs text-gray-500">Campaign: {campaignLines.join(", ")}</p>
                              )}
                            </div>
                          );
                        })()}
                        {grouped && (
                          <p className="text-xs text-gray-400 mt-1.5">
                            Same copy, creative & settings — checked once, applies to all {members.length}.
                          </p>
                        )}
                      </div>
                      <StatusBadge status={unit.status} />
                    </div>
                  );
                })()}
                <div className="px-6 py-4 space-y-4">
                  {!unit.checks && (
                    <p className="text-sm text-amber-600 py-2.5">
                      This ad unit came back without check details — re-run the QA for it.
                    </p>
                  )}
                  {unit.checks && (() => {
                    // Transform each check for display first (see displayCheckResult),
                    // then group by the DISPLAYED status so colour and grouping agree.
                    const entries = Object.entries(unit.checks ?? {}).map(
                      ([key, check]) => [key, displayCheckResult(key, check)] as const
                    );
                    const failing = entries.filter(([, c]) => c.status === "fail");
                    const warning = entries.filter(([, c]) => c.status === "warning");
                    const passing = entries.filter(([, c]) => c.status === "pass" || c.status === "unknown");
                    return (
                      <>
                        {failing.length > 0 && (
                          <div>
                            <p className="text-xs font-semibold text-red-600 uppercase tracking-wide mb-2">Fail</p>
                            <div className="space-y-2">
                              {failing.map(([key, check]) => (
                                <CheckCard key={key} label={CHECK_LABELS[key] ?? key} result={check} />
                              ))}
                            </div>
                          </div>
                        )}
                        {warning.length > 0 && (
                          <div>
                            <p className="text-xs font-semibold text-amber-600 uppercase tracking-wide mb-2">Warning</p>
                            <div className="space-y-2">
                              {warning.map(([key, check]) => (
                                <CheckCard key={key} label={CHECK_LABELS[key] ?? key} result={check} />
                              ))}
                            </div>
                          </div>
                        )}
                        {passing.length > 0 && (
                          <div>
                            <p className="text-xs font-semibold text-emerald-600 uppercase tracking-wide mb-2">Pass</p>
                            <div className="space-y-2">
                              {passing.map(([key, check]) => (
                                <CheckCard key={key} label={CHECK_LABELS[key] ?? key} result={check} />
                              ))}
                            </div>
                          </div>
                        )}
                      </>
                    );
                  })()}
                </div>
                {unit.summary && (
                  <div className="px-6 py-3 bg-gray-50 border-t border-gray-100">
                    <p className="text-xs text-gray-500">{unit.summary}</p>
                  </div>
                )}
              </div>
            ))}
            </div>
          </div>
        )}
      </main>
    </div>
  );
}
