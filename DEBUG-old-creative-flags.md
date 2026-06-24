# Debugging Vera's "old / wrong creative" false flags

Use this when Vera flags an ad as incorrect but the preview looks fine. Vera does
**not** QA the preview render — it resolves the preview link to an ad ID, pulls the
ad's full creative object from the Meta API, and grades it against an approved
reference (Drive file and/or copy doc). A false flag almost always means it graded
against the **wrong reference** or an **old asset still in the ad's pool**.

## 1. Turn on debug logging

In Vercel → Project → Settings → Environment Variables, set:

```
QA_DEBUG = 1
```

Redeploy (or push any commit) so the new env var takes effect. The exported request
log you already have is empty in the `message` column because this flag was off — it
only had request timings, not findings.

## 2. Re-run ONE bad ad

In Vera, run QA on just the single ad that's flagging wrong (one preview link, same
work order + Drive docs as before). One ad keeps the logs short.

## 3. Read these four log lines (Vercel → Logs, filter to `/api/qa`)

Find them in the function logs for that run. Each tells you a different thing:

**`[qa][sent]`** — what was fed to the model.
```
[qa][sent] unit="June Static V1" adId=120... | approvedDrive(2)=[May_Static_V1.jpg | ...] | liveMeta(1)=[...]
```
→ If the `approvedDrive` filenames are from the **wrong month / concept / version**,
that's the wrong-reference match. (The new month + ambiguity gates should now stop
most of these — if you still see a wrong-month file here, tell me the filename.)

**`[qa][extract]`** — the text the model read from each side.
```
[qa][extract] "June Static V1" status=fail | text_in_approved="...MAY..." | text_in_live="...JUNE..."
```
→ If `text_in_approved` shows an old offer/date that isn't in the live ad, it graded
against the wrong file. If `text_in_live` shows old text, the **live pool** is serving
a stale asset → next line.

**`[meta-api][img]`** — how the live image pool was reduced.
```
[meta-api][img] ad=120... carousel=false optimization_type=... pool=3 [1080x1080,1200x628,1080x1080] published_hash=yes ... → chosen=2
```
→ `pool` larger than `chosen` means stale dupes were dropped. If an OLD image still
made it into `chosen`, the stale filter didn't catch it — confirm with the next line.

**`[meta-api][stale-dbg]`** — why the stale filter did or didn't fire.
```
[meta-api][stale-dbg] ad=120... rules=0 labeled_images=0/3 rules_filter_active=false
```
→ `rules_filter_active=false` + `labeled_images=0/N` is the smoking gun: the ad has
**no asset-customization rules and no dated asset labels**, so neither the rule filter
nor the 25-day date filter can identify which pooled image is current. An old-promo
image left in `asset_feed_spec.images` then survives and gets sent to the model.

## 4. What each result means / what to do

| What you see | Root cause | Fix |
|---|---|---|
| Wrong-month/version file in `[qa][sent]` | Drive matcher picked an old approved file | Already addressed by the new gates; if it persists, the Drive folder naming needs the month/version in the filename |
| `rules_filter_active=false`, old image in `chosen` | Live pool keeps an old asset; no signal to drop it | Code change in `lib/meta-api.ts` — see note below |
| `text_in_approved` has old text but `[qa][sent]` file is correct | Model misread the right file | Re-run; if repeatable it's a prompt issue |
| Copy flag, no copy doc segmentation | Copy doc holds multiple options; model compared the wrong block | Split the copy doc per ad unit, or use Reviewer Notes to name which option this unit is |

## Note on the stale-pool fix (`lib/meta-api.ts`)

The live-image selection (around the `chosenImageCandidates` logic) currently **keeps
undated assets on uncertainty** ("can't tell the date, keep it"). That's exactly what
lets an old undated image through when the ad has no customization rules. The safe fix
is to drop undated pool extras when a concrete published image hash exists — but that
risks dropping legitimate per-placement size variants, so I did **not** blind-patch it.
Confirm with one `[meta-api][stale-dbg]` line first (does the flagged ad really have
`rules=0` and undated images?), then it's a 5-line, low-risk change. Send me that line
and I'll make it.

## Turn debug back off

Once confirmed, set `QA_DEBUG=0` (or remove it) so production logs stay quiet — they
otherwise echo creative copy.
