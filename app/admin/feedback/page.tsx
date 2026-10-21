"use client";

import { useState } from "react";

type Entry = {
  id: string;
  ts: number;
  vote: "good" | "bad";
  note: string;
  snapshot: {
    overall_status?: string;
    adCount?: number;
    woLabels?: string[];
    units?: { name: string; adId?: string | null; status: string; failing?: string[]; warning?: string[] }[];
    critical?: { label: string; detail: string; units: string[] }[];
    truncated?: boolean;
  } | null;
};

export default function FeedbackAdminPage() {
  const [password, setPassword] = useState("");
  const [entries, setEntries] = useState<Entry[] | null>(null);
  const [filter, setFilter] = useState<"all" | "bad" | "good" | "notes">("all");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [open, setOpen] = useState<string | null>(null);

  async function call(action: "list" | "delete", id?: string) {
    setBusy(true);
    setError("");
    try {
      const res = await fetch("/api/feedback/admin", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ password, action, id }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || "Request failed");
      setEntries(data.entries as Entry[]);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Request failed");
    } finally {
      setBusy(false);
    }
  }

  if (!entries) {
    return (
      <div className="min-h-screen bg-gray-50 flex items-center justify-center px-4">
        <form
          onSubmit={(e) => {
            e.preventDefault();
            if (password) call("list");
          }}
          className="bg-white rounded-2xl border border-gray-200 p-6 w-full max-w-sm space-y-4"
        >
          <p className="text-sm font-semibold text-gray-900">Feedback review (admin)</p>
          <input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            placeholder="Admin password"
            className="w-full rounded-xl border border-gray-300 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-gray-900/10"
          />
          {error && <p className="text-xs text-red-600">{error}</p>}
          <button
            type="submit"
            disabled={!password || busy}
            className="w-full px-4 py-2 rounded-xl bg-gray-900 text-white text-sm font-medium hover:bg-gray-800 disabled:opacity-40"
          >
            {busy ? "Checking…" : "Open"}
          </button>
        </form>
      </div>
    );
  }

  const good = entries.filter((e) => e.vote === "good").length;
  const bad = entries.length - good;
  const shown = entries.filter((e) =>
    filter === "all" ? true : filter === "notes" ? Boolean(e.note) : e.vote === filter
  );

  const tab = (key: typeof filter, label: string) => (
    <button
      key={key}
      onClick={() => setFilter(key)}
      className={`px-3 py-1.5 rounded-lg text-sm font-medium border ${
        filter === key ? "bg-gray-900 text-white border-gray-900" : "bg-white text-gray-700 border-gray-300 hover:bg-gray-50"
      }`}
    >
      {label}
    </button>
  );

  return (
    <div className="min-h-screen bg-gray-50 px-4 py-8">
      <div className="max-w-3xl mx-auto space-y-4">
        <div className="flex items-center justify-between">
          <div>
            <p className="text-sm font-semibold text-gray-900">Feedback review</p>
            <p className="text-xs text-gray-500">
              {entries.length} total · {good} good · {bad} bad
            </p>
          </div>
          <button
            onClick={() => call("list")}
            disabled={busy}
            className="px-3 py-1.5 rounded-lg text-sm font-medium border border-gray-300 bg-white hover:bg-gray-50 disabled:opacity-40"
          >
            Refresh
          </button>
        </div>

        <div className="flex gap-2">
          {tab("all", "All")}
          {tab("bad", "Bad")}
          {tab("good", "Good")}
          {tab("notes", "With notes")}
        </div>

        {error && <p className="text-xs text-red-600">{error}</p>}
        {shown.length === 0 && <p className="text-sm text-gray-500">Nothing here yet.</p>}

        {shown.map((e) => {
          const snap = e.snapshot;
          const isOpen = open === e.id;
          return (
            <div key={e.id} className="bg-white rounded-2xl border border-gray-200 p-5 space-y-3">
              <div className="flex items-center justify-between gap-3">
                <div className="flex items-center gap-2">
                  <span
                    className={`px-2.5 py-0.5 rounded-full text-xs font-semibold ${
                      e.vote === "good" ? "bg-emerald-50 text-emerald-700" : "bg-red-50 text-red-700"
                    }`}
                  >
                    {e.vote === "good" ? "Good" : "Bad"}
                  </span>
                  <span className="text-xs text-gray-500">
                    {new Date(e.ts).toLocaleString()}
                    {snap?.overall_status ? ` · run was ${snap.overall_status}` : ""}
                    {typeof snap?.adCount === "number" ? ` · ${snap.adCount} ads` : ""}
                  </span>
                </div>
                <div className="flex items-center gap-3">
                  {snap && (
                    <button onClick={() => setOpen(isOpen ? null : e.id)} className="text-xs text-gray-500 hover:text-gray-900">
                      {isOpen ? "Hide run" : "Show run"}
                    </button>
                  )}
                  <button
                    onClick={() => {
                      if (window.confirm("Delete this feedback entry?")) call("delete", e.id);
                    }}
                    disabled={busy}
                    className="text-xs text-red-600 hover:text-red-800 disabled:opacity-40"
                  >
                    Delete
                  </button>
                </div>
              </div>

              {e.note ? (
                <p className="text-sm text-gray-800 whitespace-pre-wrap">{e.note}</p>
              ) : (
                <p className="text-xs text-gray-400">No note</p>
              )}

              {isOpen && snap && (
                <div className="border-t border-gray-100 pt-3 space-y-3 text-xs text-gray-600">
                  {snap.woLabels && snap.woLabels.length > 0 && <p>Work orders: {snap.woLabels.join(", ")}</p>}
                  {snap.critical && snap.critical.length > 0 && (
                    <ul className="space-y-1">
                      {snap.critical.map((c, i) => (
                        <li key={i}>
                          <span className="font-medium text-red-700">{c.label}</span>
                          {c.detail ? `: ${c.detail}` : ""} ({c.units.join(", ")})
                        </li>
                      ))}
                    </ul>
                  )}
                  {snap.units && (
                    <ul className="space-y-0.5">
                      {snap.units.map((u, i) => (
                        <li key={i}>
                          {u.name} · {u.status}
                          {u.failing?.length ? ` · fail: ${u.failing.join(", ")}` : ""}
                          {u.warning?.length ? ` · warn: ${u.warning.join(", ")}` : ""}
                          {u.adId ? ` · ${u.adId}` : ""}
                        </li>
                      ))}
                    </ul>
                  )}
                  {snap.truncated && <p>Run detail was too large and was trimmed.</p>}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
