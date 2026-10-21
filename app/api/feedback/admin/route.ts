import { NextResponse } from "next/server";
import { constantTimeEqual, isAuthedRequest } from "@/lib/auth";
import { clientIp, isRateLimited, recordFailedAttempt, clearFailedAttempts } from "@/lib/rate-limit";
import { listFeedback, deleteFeedback } from "@/lib/feedback-store";

// Admin-only: list or delete feedback. Sits behind the normal site login AND a
// separate ADMIN_PASSWORD. Fails closed if ADMIN_PASSWORD isn't set.
export async function POST(request: Request) {
  if (!isAuthedRequest(request)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const limitKey = `admin:${clientIp(request)}`;
  if (await isRateLimited(limitKey)) {
    return NextResponse.json({ error: "Too many failed attempts. Try again in an hour." }, { status: 429 });
  }

  let body: { password?: unknown; action?: unknown; id?: unknown };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Bad request" }, { status: 400 });
  }

  const expected = process.env.ADMIN_PASSWORD;
  if (!expected || typeof body.password !== "string" || !constantTimeEqual(body.password, expected)) {
    await recordFailedAttempt(limitKey);
    return NextResponse.json({ error: "Incorrect admin password" }, { status: 401 });
  }
  await clearFailedAttempts(limitKey);

  try {
    if (body.action === "delete") {
      if (typeof body.id !== "string") {
        return NextResponse.json({ error: "Missing id" }, { status: 400 });
      }
      await deleteFeedback(body.id);
    }
    return NextResponse.json({ entries: await listFeedback() });
  } catch {
    return NextResponse.json({ error: "Could not reach the feedback store." }, { status: 500 });
  }
}
