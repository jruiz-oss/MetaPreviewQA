import { NextResponse } from "next/server";
import { isAuthedRequest } from "@/lib/auth";
import { addFeedback } from "@/lib/feedback-store";

const MAX_NOTE = 2000;
const MAX_SNAPSHOT_CHARS = 30000;

export async function POST(request: Request) {
  if (!isAuthedRequest(request)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  let body: { vote?: unknown; note?: unknown; snapshot?: unknown };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Bad request" }, { status: 400 });
  }

  if (body.vote !== "good" && body.vote !== "bad") {
    return NextResponse.json({ error: "Pick good or bad first" }, { status: 400 });
  }
  const note = typeof body.note === "string" ? body.note.trim().slice(0, MAX_NOTE) : "";

  // Keep the run summary small. If it's somehow huge, drop the per-ad detail
  // but keep the top-level fields so the entry is still useful.
  let snapshot: unknown = body.snapshot ?? null;
  try {
    if (JSON.stringify(snapshot).length > MAX_SNAPSHOT_CHARS) {
      const s = snapshot as Record<string, unknown>;
      snapshot = { overall_status: s?.overall_status, adCount: s?.adCount, truncated: true };
    }
  } catch {
    snapshot = null;
  }

  try {
    await addFeedback({
      id: crypto.randomUUID(),
      ts: Date.now(),
      vote: body.vote,
      note,
      snapshot,
    });
  } catch {
    return NextResponse.json({ error: "Could not save feedback. Try again." }, { status: 500 });
  }
  return NextResponse.json({ ok: true });
}
