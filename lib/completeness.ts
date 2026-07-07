import type { CreativeInventory } from "@/lib/meta-api";

// Parse "1080x1920"-style size tokens out of filenames (used for approved Drive
// assets, whose names carry the size). Returns a normalized set like {"1080x1920"}.
export function parseSizeTokens(names: string[]): Set<string> {
  const set = new Set<string>();
  for (const n of names) {
    const m = n.match(/(\d{3,4})\s*x\s*(\d{3,4})/i);
    if (m) set.add(`${m[1]}x${m[2]}`.toLowerCase());
  }
  return set;
}

// Deterministic creative-completeness line. Built from the authoritative LIVE
// inventory (computed in meta-api before any image cap) and the approved Drive
// filenames. This decouples the COMPLETENESS question (which sizes/cards exist)
// from the visual-content question (do the images match), so the vision model
// can never report a size/card "missing" merely because the QA image set was
// sampled. Mirrors the "URL comparison (computed)" pattern. Returns "" when
// there is no inventory to report.
export function computeCompletenessLine(
  inv: CreativeInventory | undefined,
  driveImages: { name: string }[],
  // FIX #16: false when the Drive refs reached this unit via a FALLBACK path
  // (zero-token-overlap pool attach or the cross-format gate) rather than a
  // confident token match. Fallback refs may belong to a different concept or
  // format, so their filename sizes are NOT authoritative for this unit — a
  // size they carry that the live ad doesn't serve must never be asserted as
  // a GENUINE GAP (degrade to couldn't-verify instead).
  confidentMatch = true
): string {
  if (!inv) return "";
  const liveSizes = inv.sizes.filter((s) => s.size !== "unknown");
  const liveSizeSet = new Set(liveSizes.map((s) => s.size));
  // FIX #12: count live assets whose dimensions Meta did NOT return. FIX #1
  // handles the all-unknown case, but a PARTIAL read has the same failure mode
  // one case narrower: if the 1080x1080 is readable and the 1080x1920 is not,
  // liveSizeSet is non-empty, so the old code asserted the 1080x1920 as a
  // GENUINE GAP even though it may be one of the unreadable assets. Any
  // unknown-dim asset means the live size set is incomplete → a size absent
  // from it cannot be asserted missing (degrade to couldn't-verify).
  const unknownCount = inv.sizes
    .filter((s) => s.size === "unknown")
    .reduce((n, s) => n + s.count, 0);
  const liveDesc = liveSizes.length
    ? liveSizes.map((s) => `${s.size} (×${s.count})`).join(", ")
    : "no sized image assets detected";

  // Genuine gaps: a size the approved Drive provides that the live ad does not
  // serve. This is the ONLY creative-completeness defect the model should flag.
  //
  // VIDEO EXCLUSION: approved Drive VIDEOS arrive as "(Drive thumbnail frame)"
  // images, but the live inventory's `sizes` counts IMAGE assets only — a live
  // video never contributes a size. So a Drive video named "… 1080x1920.mp4"
  // used to flag "1080x1920 missing live" even when the live ad serves exactly
  // that video: a false GENUINE GAP. Videos are excluded from size coverage
  // (never assert a defect the inventory can't see) and called out as
  // couldn't-verify instead.
  const isVideoRef = (n: string) => n.includes("(Drive thumbnail frame)");
  const imageRefs = driveImages.filter((d) => !isVideoRef(d.name));
  const videoRefs = driveImages.filter((d) => isVideoRef(d.name));
  const approvedSizeSet = parseSizeTokens(imageRefs.map((d) => d.name));
  const videoNote = videoRefs.length
    ? ` ${videoRefs.length} approved Drive video(s) are excluded from size coverage (live video dimensions aren't inventoried) — do NOT report a video's size as missing.`
    : "";
  let coverage = "";
  if (approvedSizeSet.size > 0) {
    if (liveSizeSet.size === 0) {
      // FIX #1: the live ad served image assets but Meta returned no readable
      // width/height for ANY of them (every entry is "unknown"), so we cannot
      // compute coverage. Asserting a GENUINE GAP here is a false positive — the
      // sizes ARE being served, we just couldn't read them. Degrade to
      // couldn't-verify rather than flagging every approved size as missing.
      coverage = ` Live asset dimensions could not be read from the Meta API, so size coverage could NOT be computed — do NOT report any size/card as missing on this basis.`;
    } else {
      const missingLive = Array.from(approvedSizeSet).filter((s) => !liveSizeSet.has(s));
      if (!missingLive.length) {
        coverage = ` All approved Drive sizes are present in the live ad — do NOT report any size/card as missing.`;
      } else if (!confidentMatch) {
        // FIX #16: the approved refs were attached by a fallback (no token
        // match / cross-format), so the "missing" size may simply belong to a
        // different concept or format than this unit. Never assert a defect
        // from uncertain input.
        coverage = ` Size(s) in attached Drive file(s) not seen live: ${missingLive.join(", ")} — but these files were fallback-matched to this unit (not a confident match) and may belong to a different concept/format, so this could NOT be verified. Do NOT report these sizes as missing; note only that size coverage couldn't be verified against a confirmed approved set.`;
      } else if (unknownCount > 0) {
        // FIX #12: some live assets had unreadable dimensions, so the live size
        // set is incomplete — the "missing" size(s) may be among them. Never
        // assert a defect from unreadable input.
        coverage = ` Size(s) in approved Drive not confirmed live: ${missingLive.join(", ")} — but ${unknownCount} live image asset(s) had unreadable dimensions and could be serving them, so this could NOT be verified. Do NOT report these sizes as missing; note only that size coverage couldn't be fully verified.`;
      } else {
        coverage = ` GENUINE GAP — size(s) in approved Drive but NOT served live: ${missingLive.join(", ")}; flag this.`;
      }
    }
  }

  const sampleNote = inv.truncated
    ? ` Only ${inv.imagesSentForVisualQa} of ${inv.imageCount} live image assets are attached below (a balanced sample across sizes) — a Vera display limit, NOT a missing asset.`
    : "";
  // FIX #14 (companion): asset-feed carousels have no configured
  // child_attachments, so cardCount is 0 — saying "0 configured card(s)" for a
  // live carousel misleads the model. Only state the count when we have one.
  const cardDesc = inv.isCarousel
    ? inv.cardCount > 0
      ? `Live carousel has ${inv.cardCount} configured card(s). `
      : `Live ad is a carousel (card count not reported by the API — do NOT infer a card count from the attached images). `
    : "";

  return `\nCreative completeness (computed): ${cardDesc}Live ad serves sizes: ${liveDesc}.${coverage}${videoNote}${sampleNote} This inventory is AUTHORITATIVE for which sizes/cards exist — never infer a size or card is missing/extra from the images attached below.`;
}
