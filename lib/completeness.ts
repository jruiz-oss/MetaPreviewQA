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
  driveImages: { name: string }[]
): string {
  if (!inv) return "";
  const liveSizes = inv.sizes.filter((s) => s.size !== "unknown");
  const liveSizeSet = new Set(liveSizes.map((s) => s.size));
  const liveDesc = liveSizes.length
    ? liveSizes.map((s) => `${s.size} (×${s.count})`).join(", ")
    : "no sized image assets detected";

  // Genuine gaps: a size the approved Drive provides that the live ad does not
  // serve. This is the ONLY creative-completeness defect the model should flag.
  const approvedSizeSet = parseSizeTokens(driveImages.map((d) => d.name));
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
      coverage = missingLive.length
        ? ` GENUINE GAP — size(s) in approved Drive but NOT served live: ${missingLive.join(", ")}; flag this.`
        : ` All approved Drive sizes are present in the live ad — do NOT report any size/card as missing.`;
    }
  }

  const sampleNote = inv.truncated
    ? ` Only ${inv.imagesSentForVisualQa} of ${inv.imageCount} live image assets are attached below (a balanced sample across sizes) — a Vera display limit, NOT a missing asset.`
    : "";
  const cardDesc = inv.isCarousel ? `Live carousel has ${inv.cardCount} configured card(s). ` : "";

  return `\nCreative completeness (computed): ${cardDesc}Live ad serves sizes: ${liveDesc}.${coverage}${sampleNote} This inventory is AUTHORITATIVE for which sizes/cards exist — never infer a size or card is missing/extra from the images attached below.`;
}
