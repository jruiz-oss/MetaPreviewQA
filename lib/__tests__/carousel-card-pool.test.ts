// Regression test for FIX #29 — carousel pool leftovers (selectCarouselCandidates).
// Run: npx tsx lib/__tests__/carousel-card-pool.test.ts
import assert from "node:assert/strict";
import { selectCarouselCandidates } from "../meta-api";

const c = (hash: string, w?: number, h?: number) => ({ url: `https://cdn/${hash}.jpg`, hash, width: w, height: h });
const hashes = (xs: { hash?: string }[]) => xs.map((x) => x.hash);

// Typical swapped carousel: 3 configured cards + the 3 old cards they replaced,
// all 1080x1080, no customization rules.
const cards = [c("new1", 1080, 1080), c("new2", 1080, 1080), c("new3", 1080, 1080)];
const old = [c("old1", 1080, 1080), c("old2", 1080, 1080), c("old3", 1080, 1080)];
const pool = [...old, ...cards];
const cardHashes = ["new1", "new2", "new3"];

// Disabled: nothing changes, but the would-drop set is reported for logging.
{
  const r = selectCarouselCandidates(pool, cardHashes, { rulesFilterActive: false, enabled: false });
  assert.deepEqual(hashes(r.kept), hashes(pool));
  assert.deepEqual(hashes(r.wouldDrop), ["old1", "old2", "old3"]);
  assert.equal(r.applied, false);
}

// Enabled: old same-size non-card images are dropped, cards kept in order.
{
  const r = selectCarouselCandidates(pool, cardHashes, { rulesFilterActive: false, enabled: true });
  assert.deepEqual(hashes(r.kept), ["new1", "new2", "new3"]);
  assert.equal(r.applied, true);
}

// Unique-size pool assets survive (per-placement story variant) — the size set
// seen by completeness/format checks must not shrink.
{
  const story = c("story", 1080, 1920);
  const r = selectCarouselCandidates([...pool, story], cardHashes, { rulesFilterActive: false, enabled: true });
  assert.deepEqual(hashes(r.kept), ["new1", "new2", "new3", "story"]);
}

// Unknown-dimension assets are never dropped (can't prove they're leftovers).
{
  const unknown = c("unk");
  const r = selectCarouselCandidates([...pool, unknown], cardHashes, { rulesFilterActive: false, enabled: true });
  assert.ok(hashes(r.kept).includes("unk"));
}

// Rules filter already active → FIX #8 owns selection; this does nothing.
{
  const r = selectCarouselCandidates(pool, cardHashes, { rulesFilterActive: true, enabled: true });
  assert.deepEqual(hashes(r.kept), hashes(pool));
  assert.equal(r.wouldDrop.length, 0);
}

// No card hashes (asset-feed carousel) → untouched.
{
  const r = selectCarouselCandidates(pool, [], { rulesFilterActive: false, enabled: true });
  assert.deepEqual(hashes(r.kept), hashes(pool));
}

// Card hashes present but none resolved to a candidate → untouched (never
// narrow on unresolved data).
{
  const r = selectCarouselCandidates(old, cardHashes, { rulesFilterActive: false, enabled: true });
  assert.deepEqual(hashes(r.kept), hashes(old));
  assert.equal(r.applied, false);
}

// Mixed carousel: video card's cover frame at a different size + statics. Only
// same-size non-card statics go.
{
  const mixed = [c("cover", 1280, 720), c("s1", 1080, 1080), c("oldS1", 1080, 1080), c("misc", 1200, 628)];
  const r = selectCarouselCandidates(mixed, ["cover", "s1"], { rulesFilterActive: false, enabled: true });
  assert.deepEqual(hashes(r.kept), ["cover", "s1", "misc"]);
}

console.log("carousel-card-pool.test.ts: all assertions passed");
