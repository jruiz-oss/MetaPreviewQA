// Drive folder-classification helpers for app/api/fetch-doc/route.ts.
// Extracted (route files can't export helpers — same pattern as
// lib/url-compare.ts and lib/format-check.ts) so the folder-sorting rules are
// unit-testable. FIX #19–#22 live here; the original rules are preserved
// verbatim and only ADDED to — never narrowed (intentional-patch policy).

// ── OLD / archive folders (FIX #19) ─────────────────────────────────────────
// Deprecated dumps must never feed the matcher — they hold last cycle's
// creative, the #1 source of "Vera sourced an old image".
//
// Original rules (kept): exactly "old"/"archive"/"archived", the "xx"/"xxOLD"
// sink-to-bottom prefix. A bare "old" substring is still NOT matched and a
// lowercase "Old ..." prefix is deliberately not matched either, so client
// names like "Old Navy" are never skipped.
//
// Added (word-boundary anchored, chosen so no real client name matches):
//   - ALL-CAPS "OLD" prefix/suffix ("OLD June", "June OLD") — the caps form is
//     the agency archive marker; "Old Navy" is title-case and stays safe.
//   - separator + "old" suffix ("Statics_OLD", "june-old", "Statics (old)").
//   - "zz" prefix — the other common sink-to-bottom convention.
//   - "archive"/"archived" as a whole word anywhere ("Archive 2025",
//     "June Archive").
//   - "do not use" / "superseded" markers.
export function isOldFolderName(rawName: string): boolean {
  const original = rawName.trim();
  const n = original.toLowerCase();
  // ── original rules (unchanged) ──
  if (
    n === "old" ||
    n === "archive" ||
    n === "archived" ||
    /^xx[\s_-]*old\b/.test(n) ||
    /^xx($|[\s_-])/.test(n)
  ) {
    return true;
  }
  // ── additions ──
  if (/^OLD\b/.test(original) || /\bOLD$/.test(original)) return true; // caps marker
  if (/[\s_-]old$/.test(n)) return true; // "june_old", "statics old"
  if (/\(old\)/.test(n)) return true; // "Statics (old)"
  if (/^zz($|[\s_-])/.test(n)) return true; // "zz Old June"
  if (/\barchived?\b/.test(n)) return true; // "Archive 2025", "June Archive"
  if (n.includes("do not use")) return true;
  if (/\bsuperseded\b/.test(n)) return true;
  return false;
}

// ── Channel folders (FIX #21) ────────────────────────────────────────────────
// Vera is Social/Meta-only. When a folder level splits by channel, navigate
// into the social channel(s) and skip the rest. The original keyword list
// (social/display/native) missed "Meta / Google / Email" style structures, so
// wrong-channel creative (display 300x250s etc.) polluted the matcher pool.

// A name matches a keyword when it IS the keyword or carries it as a
// word-anchored prefix/suffix ("Paid Social", "Social Media", "Google Display").
function nameMatchesKeyword(name: string, kw: string): boolean {
  const n = name.toLowerCase().trim();
  return n === kw || n.startsWith(kw + " ") || n.endsWith(" " + kw);
}

// Social/Meta channel names — the folders Vera SHOULD enter.
const SOCIAL_CHANNEL_KEYWORDS = [
  "social",
  "meta",
  "facebook",
  "instagram",
  "fb",
  "ig",
  "fb+ig",
  "fb & ig",
  "fb/ig",
];

// Non-social channels — presence marks a channel-level folder; contents are
// skipped. Conservative: only names that are unambiguously another channel.
const NON_SOCIAL_CHANNEL_KEYWORDS = [
  "display",
  "native",
  "programmatic",
  "search",
  "paid search",
  "sem",
  "ppc",
  "email",
  "ooh",
  "dooh",
  "google",
  "youtube",
  "tiktok",
  "pinterest",
  "snapchat",
  "linkedin",
  "ctv",
  "olv",
  "broadcast",
  "radio",
  "print",
];

export function isSocialChannelName(name: string): boolean {
  return SOCIAL_CHANNEL_KEYWORDS.some((kw) => nameMatchesKeyword(name, kw));
}

export function isChannelFolderName(name: string): boolean {
  return (
    isSocialChannelName(name) ||
    NON_SOCIAL_CHANNEL_KEYWORDS.some((kw) => nameMatchesKeyword(name, kw))
  );
}

// ALL social-matching folders (the old code `.find`-ed the first one, so a
// sibling like "Social Video/" beside "Social/" was silently skipped).
export function pickSocialFolders<T extends { name?: string | null }>(folders: T[]): T[] {
  return folders.filter((f) => isSocialChannelName(f.name ?? ""));
}

// ── Approval folders (FIX #22) ───────────────────────────────────────────────
// The strict pass queues images only from approval-named folders. Matching
// "approval" alone missed "Approved/" / "Client Approved/" siblings — the
// documented FIX #3 residual (a stray image in an old "For Approval/" folder
// suppresses the bypass rescan, so an unrecognized "Approved/" sibling stayed
// skipped). Recognizing the "approved"/"sign-off" spellings shrinks that
// residual at the gate itself. Negated forms ("Not Approved", "Unapproved")
// are explicitly excluded.
export function isApprovalFolderName(name: string): boolean {
  const n = name.toLowerCase();
  if (/\b(not|un)[\s_-]?approved\b/.test(n)) return false;
  if (n.includes("approval")) return true; // original rule, unchanged
  if (/\bapproved\b/.test(n)) return true;
  if (/\bsign[\s_-]?offs?\b/.test(n)) return true;
  return false;
}

// ── Drive shortcuts (FIX #20) ────────────────────────────────────────────────
// Shortcuts (application/vnd.google-apps.shortcut) were treated as unreadable
// files, so creative behind a folder/image shortcut — common in shared drives —
// was silently never scanned. Resolve a shortcut to its target id + mimeType;
// the existing folder cycle guard already makes following folder shortcuts
// loop-safe. Non-shortcut items pass through unchanged.
export const SHORTCUT_MIME = "application/vnd.google-apps.shortcut";

export type DriveItemLite = {
  id?: string | null;
  name?: string | null;
  mimeType?: string | null;
  shortcutDetails?: { targetId?: string | null; targetMimeType?: string | null } | null;
};

export function resolveShortcut<T extends DriveItemLite>(item: T): T {
  if (item.mimeType !== SHORTCUT_MIME) return item;
  const targetId = item.shortcutDetails?.targetId;
  const targetMime = item.shortcutDetails?.targetMimeType;
  // Unresolvable shortcut (no target info) — leave as-is; it degrades to the
  // existing "file type not readable" note rather than being dropped silently.
  if (!targetId || !targetMime) return item;
  return { ...item, id: targetId, mimeType: targetMime };
}
