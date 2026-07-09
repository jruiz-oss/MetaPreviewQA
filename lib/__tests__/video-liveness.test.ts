/**
 * Regression test for FIX #23: stale pool VIDEOS must not reach visual QA.
 *
 * asset_feed_spec.videos retains replaced videos exactly like images[] retains
 * replaced images, but only images had the customization-rules live/stale
 * filter — every pool video's thumbnail was attached, so a prior promo's video
 * surfaced as an unexplained "old creative".
 *
 * computeLiveVideoIds must return:
 *  - the rule-referenced video ids when the mapping discriminates
 *  - null (= indeterminate = keep everything) when rules carry no video_label,
 *    videos carry no adlabels, or zero videos match — NEVER an empty set.
 *
 * Run: npx tsx lib/__tests__/video-liveness.test.ts
 */
import { computeLiveVideoIds } from "@/lib/meta-api";

let failures = 0;
function assert(cond: boolean, msg: string) {
  if (cond) console.log(`  ✓ ${msg}`);
  else { console.error(`  ✗ ${msg}`); failures++; }
}

const videos = [
  { video_id: "vid_new", adlabels: [{ name: "placement_asset_a1_1751300000000" }] },
  { video_id: "vid_old", adlabels: [{ name: "placement_asset_b2_1745000000000" }] },
];

console.log("Scenario 1: rules reference only the new video → old one filtered");
{
  const rules = [{ video_label: { name: "placement_asset_a1_1751300000000" } }];
  const live = computeLiveVideoIds(videos, rules);
  assert(live !== null, "mapping is determinate");
  assert(!!live?.has("vid_new"), "new video is live");
  assert(!live?.has("vid_old"), "old video is NOT live (its thumbnail gets skipped)");
}

console.log("\nScenario 2: indeterminate inputs → null (keep everything)");
{
  assert(computeLiveVideoIds(videos, []) === null, "no rules → null");
  assert(computeLiveVideoIds(videos, [{}]) === null, "rules without video_label (image-only rules) → null");
  assert(
    computeLiveVideoIds(
      [{ video_id: "v1" }, { video_id: "v2" }],
      [{ video_label: { name: "some_label" } }]
    ) === null,
    "videos without adlabels → null (can't map rules to videos)"
  );
  assert(
    computeLiveVideoIds(videos, [{ video_label: { name: "label_matching_nothing" } }]) === null,
    "zero matches → null, never an empty set (never filter the whole comparison away)"
  );
  assert(computeLiveVideoIds(undefined, undefined) === null, "absent spec → null");
}

console.log("\nScenario 3: multiple live videos all survive");
{
  const rules = [
    { video_label: { name: "placement_asset_a1_1751300000000" } },
    { video_label: { name: "placement_asset_b2_1745000000000" } },
  ];
  const live = computeLiveVideoIds(videos, rules);
  assert(!!live?.has("vid_new") && !!live?.has("vid_old"), "both rule-referenced videos live");
}

if (failures) { console.error(`\n${failures} assertion(s) FAILED`); process.exit(1); }
console.log("\nAll assertions passed.");
