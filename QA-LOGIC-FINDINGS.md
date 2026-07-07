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

---

# Round 2 (2026-07-01) — all shipped ✅

Items 1–5 above were confirmed still fixed in code (FIX #1–#5 markers). This
round hardened the remaining creative/image paths. **These are intentional
patches — do not remove.**

## 6. Stale-asset context computed but never sent to the model ✅ fixed

`lib/meta-api.ts` computed `assetDate` + `staleNote` per live image, but
`app/api/qa/route.ts` only forwarded `videoThumbnail` + `placement` — the
stale flag was silently dropped, so old-promo assets surfaced as unexplained
phantom mismatches. Both fields are now wired into the per-image prompt label.

## 7. Approved Drive VIDEOS created false "GENUINE GAP" size findings ✅ fixed

`lib/completeness.ts`: live inventory sizes count IMAGE assets only, but Drive
video filenames ("… 1080x1920.mp4") fed the approved-size set — so a size served
live *as a video* was flagged missing. Video refs ("(Drive thumbnail frame)")
are now excluded from coverage with an explicit couldn't-verify note.
Regression test: `lib/__tests__/completeness-video-drive.test.ts`.

## 8. Stale (un-served) assets fed the dimension checks ✅ fixed

`lib/meta-api.ts`: `creativeDimensions`/`imageDimensions` were built from ALL
hashes, including pool leftovers the rules filter correctly excludes from
visual QA. A stale same-ratio asset could trigger the "multiple sizes share
one aspect ratio" warning, or satisfy a format expectation it no longer
serves. Dimensions now come from live (rule-referenced) hashes + card hashes +
the published hash; unfiltered behavior is unchanged when no rules exist.

## 9. Asset-feed carousels misclassified as statics ✅ fixed

`unitIsCarousel` relied on the name/content only; asset-feed carousels have no
"Carousel cards" block and often generic names, so the Drive format gate
misrouted their approved assets. It now checks `creativeInventory.isCarousel`
and `adFormats` first.

## 10. Silent doc/folder truncation → phantom "not in doc" findings ✅ fixed

`app/api/fetch-doc/route.ts` sliced content at 12k/30k chars with no signal.
Long copy docs lost their tail and the model reported copy "absent from the
doc". `truncateWithMarker()` now appends an explicit do-not-assert-absence note.

## 11. Unmatched-but-existing Drive creative read as "missing" ✅ fixed

When the matcher routed zero images but the Drive pool was too large for the
zero-token fallback, the model saw nothing about Drive and reported "no
approved creative found". The prompt now states creative exists but was not
auto-matched (couldn't verify — not a defect), and the pass→warning guard note
distinguishes "no Drive linked" from "Drive exists, no match".

# Round 3 (2026-07-07) — all shipped ✅

Fresh audit of the scanning logic; FIX #1–#11 confirmed intact. Four new
faults found and fixed. **Intentional patches — do not remove.**

## 12. Partial-unknown live dims still flagged false GENUINE GAPs ✅ fixed

`lib/completeness.ts`: FIX #1 only degraded when ALL live dims were unknown.
With a partial read (1080x1080 readable, 1080x1920 not), the unreadable size
was asserted as a GENUINE GAP even though it may be serving. Now any
unknown-dim asset in the inventory downgrades the gap to couldn't-verify.
Regression test: `lib/__tests__/completeness-partial-unknown.test.ts`.

## 13. URLs in post body copy hard-FAILed URL matching ✅ fixed

`extractLiveUrls` regexed URLs out of EVERY content line, so a vanity link
mentioned in "Post copy:"/"Ad bodies:" counted as a live destination →
automatic FAIL, escalated over the model. Extraction is now restricted to
URL-bearing field lines (Destination URL, Link URL, CTA URL, Landing URLs
items, Card lines). Logic moved to `lib/url-compare.ts` for testability.
Regression test: `lib/__tests__/url-compare.test.ts`.

## 14. Carousel card count excluded video cards / asset-feed = 0 ✅ fixed

`lib/meta-api.ts` passed `cardDimensions.length` (image cards only, per FIX #4)
as the AUTHORITATIVE card count — a 5-card mixed carousel reported "3
configured card(s)", asset-feed carousels "0". Now passes the full
`child_attachments.length`; `completeness.ts` says "card count not reported"
instead of "0 configured card(s)" when none is available.

## 15. Same-host secondary URL deep-links hard-FAILed ✅ fixed

Only carousel-card URLs got deep-link leniency; a secondary per-asset Landing
URL on the approved domain with a different path was a hard FAIL. URLs are now
tagged primary/secondary: FAIL is reserved for a primary mismatch or any
cross-domain URL; same-host secondary deep-links are WARNING (verify
intentional). See `lib/url-compare.ts`.

Known-minor (not fixed): when all matched Drive refs fail to download, the
prompt says creative "could not be matched" (wrong reason, same conservative
outcome); TODAY'S DATE uses UTC, so late-evening runs near a month boundary
judge promo dates against the next day.

# Round 4 (2026-07-07) — all shipped ✅

Fresh audit; FIX #1–#15 confirmed intact. Two new faults found and fixed.
**Intentional patches — do not remove.**

## 16. Fallback-matched Drive refs asserted GENUINE GAPs ✅ fixed

`computeCompletenessLine` treated the attached Drive filenames' size tokens as
"this unit's approved sizes" even when the refs arrived via the zero-token
fallback (FIX #2's whole-pool attach) or the cross-format gate — files that may
belong to a different concept/format. A cross-format static "… 1080x1920.jpg"
attached to a 1080x1080-card carousel produced "GENUINE GAP — flag this" in a
line the prompt calls authoritative. `rankRefsForUnit` now returns
`confidentMatch` (false on either fallback), wired through the batch into
`computeCompletenessLine`, which degrades the gap to couldn't-verify; the flag
is also in the dedup fingerprint so confidence differences don't merge.
Regression test: `lib/__tests__/completeness-fallback-match.test.ts`.

## 17. "static" in the ad name forced a feed-size expectation ✅ fixed

`computePlacementFormatCheck`: the token "static" set `expectsFeed`, but in ad
naming "static" means still-image (vs video/carousel), not feed placement — a
"Story Static" / "Static 9x16" unit with only a 1080x1920 asset hard-FAILed
format_size. "static" is dropped from the feed signals (feed/1x1/4x5/square/
ratio notation still enforce). The format/size check moved to
`lib/format-check.ts` for testability (route files can't export helpers).
Regression test: `lib/__tests__/format-check-static-token.test.ts`.

Known-residual (not fixed): FIX #3's approval-gate bypass only fires when the
strict pass queues ZERO images total — one stray image inside an old
"For Approval/" folder suppresses the rescan and a sibling "Final Exports/"
stays skipped. Degrades to a conservative "not matched" warning, not a false
fail.

## Model config

Model + thinking budget are env vars now: `QA_MODEL` (default
`claude-sonnet-5`) and `QA_THINKING_BUDGET` (default 3000). No code change
needed to switch or roll back.
