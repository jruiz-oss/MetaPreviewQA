/**
 * Feedback store for the "was this output good or bad" box.
 *
 * Entries live in one Redis list (newest first) on the same Upstash Redis the
 * token store and rate limiter use. Without Redis (local dev) it falls back to
 * an in-memory array that resets on restart.
 *
 * Uses POST with a JSON command body, not the GET path style the other stores
 * use, because notes can be long and would blow past URL length limits.
 */

const KEY = "vera_feedback";
const MAX_ENTRIES = 2000;

export type FeedbackEntry = {
  id: string;
  ts: number;
  vote: "good" | "bad";
  note: string;
  // Compact summary of the run that was rated (status, ads, issues).
  snapshot: unknown;
};

const memList: string[] = [];

const redisConfigured = () =>
  Boolean(process.env.KV_REST_API_URL && process.env.KV_REST_API_TOKEN);

async function cmd(args: (string | number)[]): Promise<unknown> {
  const res = await fetch(process.env.KV_REST_API_URL!, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${process.env.KV_REST_API_TOKEN}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(args),
    cache: "no-store",
  });
  if (!res.ok) throw new Error(`Redis request failed (${res.status})`);
  const data = await res.json();
  if (data.error) throw new Error(String(data.error));
  return data.result;
}

async function readRaw(): Promise<string[]> {
  if (!redisConfigured()) return [...memList];
  const raws = (await cmd(["LRANGE", KEY, 0, -1])) as string[] | null;
  return raws ?? [];
}

export async function addFeedback(entry: FeedbackEntry): Promise<void> {
  const raw = JSON.stringify(entry);
  if (!redisConfigured()) {
    memList.unshift(raw);
    if (memList.length > MAX_ENTRIES) memList.length = MAX_ENTRIES;
    return;
  }
  await cmd(["LPUSH", KEY, raw]);
  await cmd(["LTRIM", KEY, 0, MAX_ENTRIES - 1]);
}

export async function listFeedback(): Promise<FeedbackEntry[]> {
  const out: FeedbackEntry[] = [];
  for (const raw of await readRaw()) {
    try {
      out.push(JSON.parse(raw) as FeedbackEntry);
    } catch {
      // skip a corrupt row rather than failing the whole list
    }
  }
  return out;
}

export async function deleteFeedback(id: string): Promise<boolean> {
  const raws = await readRaw();
  const raw = raws.find((r) => {
    try {
      return (JSON.parse(r) as FeedbackEntry).id === id;
    } catch {
      return false;
    }
  });
  if (!raw) return false;
  if (!redisConfigured()) {
    const i = memList.indexOf(raw);
    if (i >= 0) memList.splice(i, 1);
    return true;
  }
  await cmd(["LREM", KEY, 1, raw]);
  return true;
}
