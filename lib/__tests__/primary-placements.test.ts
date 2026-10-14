import assert from "node:assert/strict";
import { primaryPlacementHashes } from "../primary-placements";

// Real shape from HROK-00046 Static V1 (2026-10-14 rules-dump).
const L = (s: string) => ({ name: `placement_asset_${s}` });
const images = [
  { hash: "igsearch", adlabels: [L("p1")] },
  { hash: "default1080", adlabels: [L("p9")] },
  { hash: "explore", adlabels: [L("p2")] },
  { hash: "profreels", adlabels: [L("p4")] },
  { hash: "an", adlabels: [L("p6")] },
  { hash: "messenger_spooky", adlabels: [L("p7")] },
  { hash: "feed_new", adlabels: [L("p3"), L("p5")] },
  { hash: "story_new", adlabels: [L("p8")] },
];
const rules = [
  { image_label: L("p1"), customization_spec: { publisher_platforms: ["instagram"], instagram_positions: ["ig_search"] } },
  { image_label: L("p2"), customization_spec: { publisher_platforms: ["instagram"], instagram_positions: ["explore"] } },
  { image_label: L("p3"), customization_spec: { publisher_platforms: ["facebook"], facebook_positions: ["right_hand_column", "search"] } },
  { image_label: L("p4"), customization_spec: { publisher_platforms: ["instagram"], instagram_positions: ["profile_reels"] } },
  { image_label: L("p5"), customization_spec: { publisher_platforms: ["facebook", "instagram"], facebook_positions: ["feed", "instream_video", "profile_feed"], instagram_positions: ["stream", "profile_feed"] } },
  { image_label: L("p6"), customization_spec: { publisher_platforms: ["audience_network"], audience_network_positions: ["classic", "rewarded_video"] } },
  { image_label: L("p7"), customization_spec: { publisher_platforms: ["messenger"], messenger_positions: ["story"] } },
  { image_label: L("p8"), customization_spec: { publisher_platforms: ["facebook", "instagram"], facebook_positions: ["story", "facebook_reels"], instagram_positions: ["story", "reels"] } },
  { image_label: L("p9"), customization_spec: {} },
];

const got = primaryPlacementHashes(rules, images);
assert.deepEqual(Array.from(got ?? []).sort(), ["feed_new", "story_new"]);

// "Customize Stories only" shape: default rule IS the feed image → kept.
const got2 = primaryPlacementHashes(
  [rules[7], { image_label: L("p9"), customization_spec: {} }],
  [{ hash: "story_new", adlabels: [L("p8")] }, { hash: "default1080", adlabels: [L("p9")] }]
);
assert.deepEqual(Array.from(got2 ?? []).sort(), ["default1080", "story_new"]);

// Only minor placements → null (caller keeps existing behavior, never empties).
assert.equal(primaryPlacementHashes([rules[6]], [images[5]]), null);
// No rules → null.
assert.equal(primaryPlacementHashes([], images), null);

console.log("primary-placements: all passed");
