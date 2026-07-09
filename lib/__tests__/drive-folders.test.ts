/**
 * Regression tests for FIX #19–#22 (lib/drive-folders.ts):
 *  #19 broadened OLD/archive lexicon — original rules preserved, additions
 *      word-anchored so client names ("Old Navy", "Harold's") never match
 *  #20 Drive shortcut resolution (folder + media shortcuts follow their target)
 *  #21 channel lexicon (Meta/Facebook/Paid Search/…) + ALL social folders picked
 *  #22 approval-gate recognizes "Approved"/"Sign-Off"; negations excluded
 *
 * Run: npx tsx lib/__tests__/drive-folders.test.ts
 */
import {
  isOldFolderName,
  isChannelFolderName,
  isSocialChannelName,
  isApprovalFolderName,
  pickSocialFolders,
  resolveShortcut,
  SHORTCUT_MIME,
} from "@/lib/drive-folders";

let failures = 0;
function assert(cond: boolean, msg: string) {
  if (cond) console.log(`  ✓ ${msg}`);
  else { console.error(`  ✗ ${msg}`); failures++; }
}

console.log("Scenario 1: OLD lexicon — original rules still hold");
{
  for (const n of ["old", "OLD", "Archive", "archived", "xxOLD", "xx old", "xx_old June", "xx June"]) {
    assert(isOldFolderName(n), `"${n}" is OLD (original rule)`);
  }
}

console.log("\nScenario 2: OLD lexicon — new archive spellings caught");
{
  for (const n of [
    "OLD June", "OLD - Statics", "June OLD", "Statics_OLD", "june-old",
    "Statics (old)", "zz Old June", "zz_2025", "Archive 2025", "June Archive",
    "Archived Creative", "DO NOT USE", "do not use - wrong logo", "Superseded exports",
  ]) {
    assert(isOldFolderName(n), `"${n}" is OLD (new rule)`);
  }
}

console.log("\nScenario 3: OLD lexicon — client/brand names stay safe");
{
  for (const n of [
    "Old Navy", "Old Navy June Statics", "Harold's Chicken", "Goldsmith Resort",
    "Cotswold Tourism", "Marigold Spa", "Golden Oldies Radio Promo", "Threshold Campaign",
  ]) {
    assert(!isOldFolderName(n), `"${n}" is NOT old`);
  }
}

console.log("\nScenario 4: channel names — social synonyms + non-social channels");
{
  for (const n of ["Social", "Paid Social", "Social Media", "Meta", "Meta Ads", "Facebook", "Instagram", "FB", "IG"]) {
    assert(isSocialChannelName(n), `"${n}" is a social channel`);
  }
  for (const n of ["Display", "Native", "Paid Search", "SEM", "Email", "Google", "Google Display", "YouTube", "OOH", "Programmatic", "TikTok"]) {
    assert(isChannelFolderName(n) && !isSocialChannelName(n), `"${n}" is a (non-social) channel`);
  }
  // Regular campaign folders must NOT read as channels.
  for (const n of ["June 2026", "HRok GC Giveaway", "Statics", "Carousels", "V1", "For Approval"]) {
    assert(!isChannelFolderName(n), `"${n}" is not a channel folder`);
  }
}

console.log("\nScenario 5: ALL social folders picked (not just the first)");
{
  const folders = [
    { name: "Display" },
    { name: "Social" },
    { name: "Social Video" },
    { name: "Native" },
    { name: "Meta Statics" },
  ];
  const picked = pickSocialFolders(folders).map((f) => f.name);
  assert(picked.includes("Social"), "picks 'Social'");
  assert(picked.includes("Social Video"), "picks 'Social Video' (old .find() skipped it)");
  assert(picked.includes("Meta Statics"), "picks 'Meta Statics'");
  assert(!picked.includes("Display") && !picked.includes("Native"), "skips Display/Native");
}

console.log("\nScenario 6: approval names — broadened but negation-safe");
{
  for (const n of ["For Approval", "Approvals", "Client Approval", "Approved", "Client Approved", "Approved Exports", "Sign-Off", "Signoff", "Sign Offs"]) {
    assert(isApprovalFolderName(n), `"${n}" gates as approval`);
  }
  for (const n of ["Not Approved", "Unapproved", "not_approved", "Creative", "Incoming", "Working Files"]) {
    assert(!isApprovalFolderName(n), `"${n}" does NOT gate as approval`);
  }
}

console.log("\nScenario 7: shortcut resolution");
{
  const folderShortcut = {
    id: "shortcut1",
    name: "Final Exports (shortcut)",
    mimeType: SHORTCUT_MIME,
    shortcutDetails: { targetId: "realFolder9", targetMimeType: "application/vnd.google-apps.folder" },
  };
  const resolved = resolveShortcut(folderShortcut);
  assert(resolved.id === "realFolder9", "folder shortcut resolves to target id");
  assert(resolved.mimeType === "application/vnd.google-apps.folder", "…and target mimeType (recurses like a real folder)");
  assert(resolved.name === "Final Exports (shortcut)", "shortcut keeps its own display name");

  const imgShortcut = {
    id: "s2",
    name: "Hero 1080x1080.jpg",
    mimeType: SHORTCUT_MIME,
    shortcutDetails: { targetId: "img77", targetMimeType: "image/jpeg" },
  };
  const rImg = resolveShortcut(imgShortcut);
  assert(rImg.id === "img77" && rImg.mimeType === "image/jpeg", "image shortcut queues its TARGET id (downloadable bytes)");

  const broken = { id: "s3", name: "Dead link", mimeType: SHORTCUT_MIME, shortcutDetails: null };
  assert(resolveShortcut(broken).id === "s3", "unresolvable shortcut passes through unchanged (degrades to 'not readable' note)");

  const normal = { id: "f1", name: "Promo.jpg", mimeType: "image/jpeg" };
  assert(resolveShortcut(normal).id === "f1", "non-shortcut items untouched");
}

if (failures) { console.error(`\n${failures} assertion(s) FAILED`); process.exit(1); }
console.log("\nAll assertions passed.");
