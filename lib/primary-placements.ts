// Primary-placement filter for placement-customized single-image ads.
//
// Jorge's rule (2026-10-14): Vera only cares about the images on the main
// placements: Feeds (+ FB right column / search) and FB/IG Stories + Reels.
// Every other customization slot (Messenger Stories, IG Search / Explore /
// Profile Reels, Audience Network, the "default" catch-all, ...) is ignored
// completely. Duplicated ad sets keep old creative in those minor slots, and
// Vera was grading the new ads against it (HROK-00046, Spooky Slot in
// Messenger Stories).

export type CustomizationRuleLike = {
  image_label?: { name?: string };
  customization_spec?: Record<string, unknown>;
};
export type PoolImageLike = { hash?: string; adlabels?: Array<{ name?: string }> };

const PRIMARY_POSITIONS: Record<string, Set<string>> = {
  facebook_positions: new Set(["feed", "right_hand_column", "search", "story", "facebook_reels"]),
  instagram_positions: new Set(["stream", "story", "reels"]),
};
const FEED_POSITIONS: Record<string, Set<string>> = {
  facebook_positions: new Set(["feed"]),
  instagram_positions: new Set(["stream"]),
};

function hasAnyPosition(spec: Record<string, unknown> | undefined, map: Record<string, Set<string>>): boolean {
  if (!spec) return false;
  for (const [key, allowed] of Object.entries(map)) {
    const positions = (spec[key] as string[] | undefined) ?? [];
    if (positions.some((p) => allowed.has(p))) return true;
  }
  return false;
}

/** True for the "default / all remaining placements" rule (no positions at all). */
function isDefaultRule(spec: Record<string, unknown> | undefined): boolean {
  if (!spec) return true;
  return !["facebook_positions", "instagram_positions", "messenger_positions", "audience_network_positions", "threads_positions"]
    .some((k) => ((spec[k] as string[] | undefined) ?? []).length > 0);
}

/**
 * Hashes of pool images that serve a primary placement. Returns null when the
 * ad has no usable primary rule (no customization, unlabeled pool, or nothing
 * matched); callers then keep their existing behavior rather than empty the
 * comparison.
 *
 * The default rule is ignored whenever another rule already covers Feeds. If
 * no rule covers Feeds, the default rule IS the Feed image (Meta's common
 * "customize Stories only" shape), so it is kept in that case only.
 */
export function primaryPlacementHashes(
  rules: CustomizationRuleLike[],
  images: PoolImageLike[]
): Set<string> | null {
  if (!rules.length || !images.length) return null;
  const feedCovered = rules.some((r) => r.image_label?.name && hasAnyPosition(r.customization_spec, FEED_POSITIONS));
  const labels = new Set<string>();
  for (const r of rules) {
    const name = r.image_label?.name;
    if (!name) continue;
    if (hasAnyPosition(r.customization_spec, PRIMARY_POSITIONS) || (!feedCovered && isDefaultRule(r.customization_spec))) {
      labels.add(name);
    }
  }
  if (!labels.size) return null;
  const hashes = new Set<string>();
  for (const img of images) {
    if (img.hash && (img.adlabels ?? []).some((l) => l.name && labels.has(l.name))) hashes.add(img.hash);
  }
  return hashes.size ? hashes : null;
}
