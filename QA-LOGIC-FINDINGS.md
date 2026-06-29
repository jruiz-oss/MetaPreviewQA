# Vera — QA Logic Findings

Audit of the QA pipeline for logic bugs that produce false results (especially false
"no creative / size missing" findings). Each item is a concrete code issue with a fix.

**Common root cause across all of these:** deterministic checks assert a *negative*
("missing", "gap", "fail") from incomplete input, instead of degrading to "couldn't
verify." That's why every run surfaces a new false fail.

---

## 1. False "size missing / no creative" when Meta returns no image dimensions  ✅ reproduced

**File:** `lib/completeness.ts` (`computeCompletenessLine`)

If the live inventory has no *known* sizes — Meta returned assets but no width/height, so
every entry is `"unknown"` — `liveSizeSet` is empty, and **every** approved Drive size
becomes a `GENUINE GAP`.

Reproduced with an inventory of 2 live images, both `unknown` dims:

> `Live ad serves sizes: no sized image assets detected. GENUINE GAP — size(s) in
> approved Drive but NOT served live: 1080x1080, 1080x1920; flag this.`

The ad *is* serving those sizes; we just couldn't read dims.

**Fix:** when `liveSizeSet.size === 0`, do not emit a gap. Say sizes couldn't be
determined and skip the coverage assertion (degrade to "couldn't verify").

---

## 2. "No creative in Drive" when the matcher finds zero shared tokens  (main recurring complaint)

**File:** `app/api/qa/route.ts` (`rankRefsForUnit`)

The ranker requires `score > 0` — at least one token shared between the ad unit
name/copy and a Drive filename:

```
.filter((x) => x.score > 0) // require at least one shared token
...
if (!scored.length) return { refs: [], crossFormat: false }; // no match → no Drive comparison
```

Generic unit names ("May Static V1") + Drive files named only by concept (no overlap) →
**zero images returned**, and the model reports "no approved creative found." The
creative exists; the matcher routed nothing.

**Fix:** when nothing scores but the total Drive pool is small (e.g. ≤ per-unit cap),
fall back to sending the whole capped pool instead of an empty set.

---

## 3. Approval-gating skips real creative in folders not named "approval"

**File:** `app/api/fetch-doc/route.ts` (`readDriveFolder`)

Images are queued only when `insideApprovalFolder` is true. The depth-0 auto-approve
only fires when **no** subfolder contains "approval." So a root containing both
`For Approval/` (old/empty) and `Final Exports/` (the real creative) leaves
`effectiveInsideApproval = false` for `Final Exports/`, and its images are silently
skipped → "no creative."

**Fix:** make the gate less brittle — e.g. if an approval branch yields zero queued
images, fall back to queueing images from the richest non-Creative/non-OLD sibling, or
treat the linked root as in-approval when only one non-archive content folder exists.

---

## 4. Carousel with a video card flagged as a hard FAIL

**File:** `app/api/qa/route.ts` (`checkDimensionConsistency`, Rule 1)

Rule 1 fails any carousel whose cards aren't all one exact WxH. A carousel that mixes a
video card (different resolution) with image cards is legitimate but gets a FAIL. Rule 2
already excludes video dims for the image-consistency check; Rule 1 does not.

**Fix:** exclude video-card dimensions from the carousel-uniformity check (compare image
cards to image cards only).

---

## 5. Table copy gets glued together → phantom copy mismatches

**File:** `app/api/fetch-doc/route.ts` (`extractDocText`)

Text runs are joined with `""`. Adjacent table cells merge with no separator
("Price" + "Free" → "PriceFree"), which can create false copy-alignment mismatches when
the copy doc uses tables.

**Fix:** insert a separator (space or newline) between table cells and between paragraphs.

---

## Suggested guardrail (prevents the "always a new issue" pattern)

Every deterministic check should follow one rule: **never assert a defect from absent or
unreadable input.** If the input needed to judge a check is missing (no dims, no matched
asset, unreadable file), the check returns `warning`/`unknown` with "couldn't verify" —
never `fail` or `GENUINE GAP`. Items 1–5 are all violations of this single principle.

Each fix should ship with a regression test alongside
`lib/__tests__/carousel-completeness.test.ts`.
