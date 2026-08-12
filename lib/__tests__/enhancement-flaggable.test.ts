/**
 * Regression test for FIX #28 (lib/meta-api.ts → isFlaggableEnhancementKey).
 *
 * Production false positive (Camelback, 2026-08-12): Vera reported
 * "ig video native subtitle, Adjust Brightness & Contrast, Standard
 * Enhancements (legacy) are ON" on a video ad. The reviewer could not find any
 * of those switched on, because two of the three have no Ads Manager toggle at
 * all — `ig_video_native_subtitle` is an IG-side system field (it wasn't even
 * in ENHANCEMENT_LABELS, which is why it printed as a raw key) and
 * `standard_enhancements` was retired from the UI but is still reported OPT_IN
 * on older creatives.
 *
 * Rule under test: only keys with a real user-controllable toggle can produce a
 * finding. Legacy, system-level, and unrecognised keys degrade to informational
 * — consistent with the codebase rule of never asserting a defect from input we
 * can't interpret.
 *
 * Run: npx tsx lib/__tests__/enhancement-flaggable.test.ts
 */
import { isFlaggableEnhancementKey, ALLOWED_ENHANCEMENT_KEYS } from "@/lib/meta-api";

let failures = 0;
function assert(cond: boolean, msg: string) {
  if (cond) console.log(`  ✓ ${msg}`);
  else { console.error(`  ✗ ${msg}`); failures++; }
}

console.log("Scenario 1: the three keys from the Camelback false positive");
{
  assert(isFlaggableEnhancementKey("image_brightness_and_contrast") === true,
    "Adjust Brightness & Contrast IS a real toggle → still flaggable (no coverage lost)");
  assert(isFlaggableEnhancementKey("standard_enhancements") === false,
    "Standard Enhancements (legacy) → not flaggable (retired from Ads Manager)");
  assert(isFlaggableEnhancementKey("ig_video_native_subtitle") === false,
    "ig_video_native_subtitle → not flaggable (IG system field, no toggle)");
}

console.log("Scenario 2: genuine toggles remain flaggable");
{
  for (const key of [
    "image_templates", "image_touchups", "video_auto_crop", "text_optimizations",
    "reveal_details_over_time", "text_translation", "add_text_overlay",
    "enhance_cta", "image_uncrop", "image_animation", "video_highlights",
    "site_extensions", "biz_ai", "music",
  ]) {
    assert(isFlaggableEnhancementKey(key) === true, `${key} → flaggable`);
  }
}

console.log("Scenario 3: allowed-by-policy keys never flag");
{
  assert(ALLOWED_ENHANCEMENT_KEYS.has("inline_comment"), "inline_comment is allowed by policy");
  assert(isFlaggableEnhancementKey("inline_comment") === false,
    "Relevant Comments ON is not a finding");
}

console.log("Scenario 4: unrecognised future keys degrade to informational");
{
  assert(isFlaggableEnhancementKey("some_brand_new_meta_field") === false,
    "unknown key → not flaggable (never assert a defect from input we can't interpret)");
  assert(isFlaggableEnhancementKey("") === false, "empty key → not flaggable");
}

if (failures) { console.error(`\n${failures} assertion(s) FAILED`); process.exit(1); }
console.log("\nAll assertions passed.");
