"use client";

import { useState } from "react";

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
  const [units, setUnits] = useState<AdUnit[]>([
    { id: "1", name: "", link: "" },
    { id: "2", name: "", link: "" },
  ]);
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<QAResult | null>(null);
  const [error, setError] = useState("");

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

  function updateUnit(id: string, field: "name" | "link", value: string) {
    setUnits((prev) =>
      prev.map((u) => (u.id === id ? { ...u, [field]: value } : u))
    );
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
        body: JSON.stringify({ wo, units: filledUnits }),
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

  return (
    <div className="min-h-screen bg-[#f8f8f6]">
      <header className="border-b border-gray-200 bg-white px-6 py-4 flex items-center justify-between">
        <div className="flex items-center gap-3">
          <span className="text-xs font-medium tracking-widest text-gray-400 uppercase">
            Commit Agency
          </span>
          <span className="text-gray-200">|</span>
          <h1 className="text-sm font-semibold text-gray-900">Ad QA Tool</h1>
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
        {!result ? (
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
                onChange={(e) => setWo(e.target.value)}
                rows={6}
                placeholder="e.g. June Gift Giveaway — carousel + static ads. Fan giveaway imagery (beach theme). Promo runs June 1–30. CTA links to brand.com/june-giveaway. Copy should reference the fan sweepstakes, not cooking products."
                className="w-full px-4 py-3 rounded-xl border border-gray-200 bg-gray-50 text-sm text-gray-900 placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-gray-900 focus:border-transparent resize-none"
              />
            </div>

            {/* Step 2 — Ad Units */}
            <div className="bg-white rounded-2xl border border-gray-200 p-6">
              <div className="mb-4">
                <p className="text-xs font-medium tracking-widest text-gray-400 uppercase mb-1">
                  Step 2
                </p>
                <h2 className="text-base font-semibold text-gray-900">
                  Ad preview links
                </h2>
                <p className="text-sm text-gray-500 mt-0.5">
                  One row per ad unit. Paste the Meta preview link — creative content is pulled automatically via the API.
                </p>
              </div>

              {/* Column headers */}
              <div className="grid grid-cols-[1fr_2fr_32px] gap-3 mb-2 px-1">
                <span className="text-xs font-medium text-gray-400 uppercase tracking-wide">
                  Ad unit name
                </span>
                <span className="text-xs font-medium text-gray-400 uppercase tracking-wide">
                  Preview link
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
                      placeholder="https://..."
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
              className="w-full py-3.5 rounded-2xl bg-gray-900 text-white text-sm font-medium hover:bg-gray-800 transition-colors disabled:opacity-40 disabled:cursor-not-allowed flex items-center justify-center gap-2"
            >
              {loading ? (
                <>
                  <span className="inline-block w-4 h-4 border-2 border-white/30 border-t-white rounded-full animate-spin" />
                  Running QA check...
                </>
              ) : (
                "Run QA check"
              )}
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
                  <p className="text-sm text-gray-500 mt-1">{result.notes}</p>
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
