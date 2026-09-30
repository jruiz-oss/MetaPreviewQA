// Deterministic "are these carousel cards the same image?" check.
//
// Why: on 2026-09-29 an Altura carousel went live with two near-identical images
// where the approved Drive set has four DIFFERENT cards (one card had been swapped
// and its predecessor / a copy of it was still in the ad). The vision model was
// never asked to count distinct cards and is told not to infer missing/extra cards,
// so nothing flagged it. This compares perceptual fingerprints in code instead.
//
// Self-calibrating: the "same image" radius is derived from how far apart the
// APPROVED cards are from each other, so templated cards that legitimately look
// alike can never be merged into a false duplicate. When the approved cards are too
// close to tell apart, the group is skipped (couldn't verify) rather than guessed.
import sharp from "sharp";

export type FP = { label: string; aspect: number; bits: Uint8Array };

const GRID = 16; // 16 rows x 16 comparisons = 256-bit difference hash
const ABS_MAX_RADIUS = 24; // ≈9% of bits — recompression / small text edits stay well inside this
const MIN_RADIUS = 3; // below this the approved cards are too alike to tell apart

export async function fingerprint(base64: string, label: string): Promise<FP | null> {
  try {
    const buf = Buffer.from(base64, "base64");
    const meta = await sharp(buf).metadata();
    if (!meta.width || !meta.height) return null;
    const raw = await sharp(buf)
      .greyscale()
      .resize(GRID + 1, GRID, { fit: "fill" })
      .raw()
      .toBuffer();
    const bits = new Uint8Array(GRID * GRID);
    for (let y = 0; y < GRID; y++) {
      for (let x = 0; x < GRID; x++) {
        bits[y * GRID + x] = raw[y * (GRID + 1) + x] > raw[y * (GRID + 1) + x + 1] ? 1 : 0;
      }
    }
    return { label, aspect: meta.width / meta.height, bits };
  } catch {
    return null; // unreadable image → no fingerprint, never a finding
  }
}

export function hamming(a: Uint8Array, b: Uint8Array): number {
  let d = 0;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) d++;
  return d;
}

// Bucket aspect ratios so a 1254x1254 live card and a 1080x1080 approved card are
// the same group, while 1:1 and 9:16 sets are never compared with each other.
export function aspectKey(a: number): string {
  const known: [string, number][] = [["1:1", 1], ["4:5", 0.8], ["9:16", 0.5625], ["1.91:1", 1.91], ["16:9", 1.778]];
  for (const [k, v] of known) if (Math.abs(a - v) <= 0.04) return k;
  return `r${a.toFixed(2)}`;
}

const GROUP_LABEL: Record<string, string> = {
  "1:1": "Square (1:1)",
  "4:5": "Vertical (4:5)",
  "9:16": "Story (9:16)",
  "1.91:1": "Landscape (1.91:1)",
  "16:9": "Landscape (16:9)",
};

export type CoverageResult = { severity: "fail" | "warning" | null; notes: string[]; debug: string[] };

export function analyzeCardCoverage(live: FP[], approved: FP[]): CoverageResult {
  const notes: string[] = [];
  const debug: string[] = [];
  let severity: "fail" | "warning" | null = null;
  const bump = (s: "fail" | "warning") => {
    if (s === "fail" || severity === null) severity = s;
  };

  const groups = new Set([...live, ...approved].map((f) => aspectKey(f.aspect)));
  for (const g of Array.from(groups).sort()) {
    const L = live.filter((f) => aspectKey(f.aspect) === g);
    const A = approved.filter((f) => aspectKey(f.aspect) === g);
    if (A.length < 2 || L.length < 1) {
      debug.push(`group ${g}: skipped (approved=${A.length} live=${L.length})`);
      continue;
    }
    let minPair = Infinity;
    for (let i = 0; i < A.length; i++)
      for (let j = i + 1; j < A.length; j++) minPair = Math.min(minPair, hamming(A[i].bits, A[j].bits));
    const R = Math.min(ABS_MAX_RADIUS, Math.floor(minPair / 2));
    if (R < MIN_RADIUS) {
      debug.push(`group ${g}: skipped — approved cards too alike to tell apart (minPair=${minPair}, R=${R})`);
      continue;
    }

    // Cluster the live images by mutual closeness (union-find).
    const parent = L.map((_, i) => i);
    const find = (i: number): number => (parent[i] === i ? i : (parent[i] = find(parent[i])));
    for (let i = 0; i < L.length; i++)
      for (let j = i + 1; j < L.length; j++)
        if (hamming(L[i].bits, L[j].bits) <= R) parent[find(i)] = find(j);
    const clusters = new Map<number, FP[]>();
    L.forEach((f, i) => {
      const r = find(i);
      clusters.set(r, [...(clusters.get(r) ?? []), f]);
    });
    const distinct = clusters.size;
    const unmatched = A.filter((a) => !L.some((l) => hamming(a.bits, l.bits) <= R));
    debug.push(
      `group ${g}: approved=${A.length} live=${L.length} distinctLive=${distinct} R=${R} minApprovedPair=${minPair} ` +
        `unmatchedApproved=${unmatched.length}`
    );

    // Round 8b: plain-language notes (Jorge, 2026-09-30). No file names or
    // image IDs; say what's wrong in reviewer terms. The duplicate + shortfall
    // + missing card read as ONE finding per aspect set.
    const shortfall = distinct < A.length;
    const dupClusters = Array.from(clusters.values()).filter((m) => m.length >= 2);
    const G = GROUP_LABEL[g] ?? g;
    const parts: string[] = [];
    if (dupClusters.length) {
      const twice = dupClusters.length === 1 ? "one card appears twice" : "some cards appear twice";
      parts.push(
        shortfall
          ? `the approved folder has ${A.length} different cards but the ad shows only ${distinct} (${twice})`
          : `${twice}`
      );
      bump(shortfall ? "fail" : "warning");
    }
    if (unmatched.length) {
      parts.push(`missing approved ${unmatched.map((u) => u.label).join(", ")}`);
      bump(shortfall ? "fail" : "warning");
    }
    if (parts.length) notes.push(`${G} carousel: ${parts.join("; ")}`);
  }
  return { severity, notes, debug };
}

// Pure: fold a coverage result into creative_alignment.
export function applyCoverage(
  check: Record<string, unknown> | undefined,
  res: CoverageResult
): Record<string, unknown> | undefined {
  if (!res.severity || res.notes.length === 0) return check;
  const note = res.notes.join("; ");
  const prev = check && typeof check.note === "string" ? check.note.trim() : "";
  const prevStatus = check?.status;
  const keepPrev = prev && (prevStatus === "fail" || prevStatus === "warning");
  const status = prevStatus === "fail" || res.severity === "fail" ? "fail" : "warning";
  return { ...(check ?? {}), status, note: keepPrev ? `${prev}; ${note}` : note };
}

// ─── Human names for live images (Round 8b, Jorge 2026-09-30) ───────────────
// Live Meta images only have CDN file names ("825268710_1613…_n.png"), which
// mean nothing to a reviewer. Name each live image after the approved Drive
// file it visually matches (same fingerprint + radius rules as the coverage
// check above), plus its live size: 'Carousel 1080x1080 - 2 (live 1254×1254)'.
// No confident match → just the size ('live 1779×400 image'). This is a
// NAMING aid only; it never decides a pass/fail.
export function driveDisplayName(name: string): string {
  const base = (name.split("/").pop() ?? name).replace(/\s*\(Drive thumbnail frame\)\s*$/i, "");
  return base.replace(/\.[a-z0-9]{2,4}$/i, "").trim();
}

export async function nameLiveImages(
  live: { data: string }[],
  approved: { data: string; name: string }[]
): Promise<string[]> {
  const sizeOf = async (b64: string) => {
    try {
      const m = await sharp(Buffer.from(b64, "base64")).metadata();
      return m.width && m.height ? `${m.width}×${m.height}` : null;
    } catch {
      return null;
    }
  };
  const [liveFps, apprFps, sizes] = await Promise.all([
    Promise.all(live.map((l, i) => fingerprint(l.data, String(i)))),
    Promise.all(approved.map((a) => fingerprint(a.data, driveDisplayName(a.name)))),
    Promise.all(live.map((l) => sizeOf(l.data))),
  ]);
  const A = apprFps.filter((f): f is FP => !!f);
  return live.map((_, i) => {
    const size = sizes[i];
    const f = liveFps[i];
    const sized = size ? `live ${size}` : "live image";
    if (!f) return size ? `live ${size} image` : "live image";
    const group = A.filter((a) => aspectKey(a.aspect) === aspectKey(f.aspect));
    if (!group.length) return size ? `live ${size} image` : "live image";
    let minPair = Infinity;
    for (let x = 0; x < group.length; x++)
      for (let y = x + 1; y < group.length; y++) minPair = Math.min(minPair, hamming(group[x].bits, group[y].bits));
    const R = group.length > 1 ? Math.min(ABS_MAX_RADIUS, Math.floor(minPair / 2)) : ABS_MAX_RADIUS;
    if (R < MIN_RADIUS) return size ? `live ${size} image` : "live image";
    let best: FP | null = null;
    let bestD = Infinity;
    for (const a of group) {
      const d = hamming(a.bits, f.bits);
      if (d < bestD) { bestD = d; best = a; }
    }
    return best && bestD <= R ? `"${best.label}" (${sized})` : size ? `live ${size} image, no matching approved file` : "live image";
  });
}
