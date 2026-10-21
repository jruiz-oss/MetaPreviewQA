"use client";

import { useState } from "react";

type Vote = "good" | "bad";

// "Was this output good or bad?" box shown under the QA results. Only the
// good/bad toggle is required; the note is optional. The parent keys this by
// run so a fresh run starts a fresh box.
export default function FeedbackBox({ buildSnapshot }: { buildSnapshot: () => unknown }) {
  const [vote, setVote] = useState<Vote | null>(null);
  const [note, setNote] = useState("");
  const [status, setStatus] = useState<"idle" | "sending" | "sent" | "error">("idle");
  const [errMsg, setErrMsg] = useState("");

  async function submit() {
    if (!vote || status === "sending") return;
    setStatus("sending");
    setErrMsg("");
    try {
      const res = await fetch("/api/feedback", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ vote, note, snapshot: buildSnapshot() }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || "Could not send feedback");
      }
      setStatus("sent");
    } catch (e) {
      setErrMsg(e instanceof Error ? e.message : "Could not send feedback");
      setStatus("error");
    }
  }

  if (status === "sent") {
    return (
      <div className="bg-white rounded-2xl border border-gray-200 px-6 py-5">
        <p className="text-sm font-medium text-gray-900">Thanks, feedback sent.</p>
      </div>
    );
  }

  const base =
    "inline-flex items-center gap-2 px-4 py-2 rounded-xl border text-sm font-medium transition-colors";
  const off = "border-gray-300 bg-white text-gray-700 hover:bg-gray-50";

  return (
    <div className="bg-white rounded-2xl border border-gray-200 p-6 space-y-4">
      <p className="text-sm font-semibold text-gray-900">Was this output good or bad?</p>

      <div className="flex gap-2">
        <button
          type="button"
          onClick={() => setVote(vote === "good" ? null : "good")}
          aria-pressed={vote === "good"}
          className={`${base} ${vote === "good" ? "border-emerald-500 bg-emerald-50 text-emerald-700" : off}`}
        >
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M14 9V5a3 3 0 0 0-3-3l-4 9v11h11.28a2 2 0 0 0 2-1.7l1.38-9a2 2 0 0 0-2-2.3zM7 22H4a2 2 0 0 1-2-2v-7a2 2 0 0 1 2-2h3" />
          </svg>
          Good
        </button>
        <button
          type="button"
          onClick={() => setVote(vote === "bad" ? null : "bad")}
          aria-pressed={vote === "bad"}
          className={`${base} ${vote === "bad" ? "border-red-500 bg-red-50 text-red-700" : off}`}
        >
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M10 15v4a3 3 0 0 0 3 3l4-9V2H5.72a2 2 0 0 0-2 1.7l-1.38 9a2 2 0 0 0 2 2.3zm7-13h2.67A2.31 2.31 0 0 1 22 4v7a2.31 2.31 0 0 1-2.33 2H17" />
          </svg>
          Bad
        </button>
      </div>

      <textarea
        value={note}
        onChange={(e) => setNote(e.target.value)}
        maxLength={2000}
        rows={3}
        placeholder="Anything to add? (optional)"
        className="w-full rounded-xl border border-gray-300 px-3 py-2 text-sm text-gray-900 placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-gray-900/10"
      />

      <div className="flex items-center gap-3">
        <button
          type="button"
          onClick={submit}
          disabled={!vote || status === "sending"}
          className="px-4 py-2 rounded-xl bg-gray-900 text-white text-sm font-medium hover:bg-gray-800 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
        >
          {status === "sending" ? "Sending…" : "Submit"}
        </button>
        {status === "error" && <p className="text-xs text-red-600">{errMsg}</p>}
      </div>
    </div>
  );
}
