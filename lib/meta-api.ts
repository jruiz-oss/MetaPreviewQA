// Meta Graph API base. Bump this comment to trigger a fresh deploy when needed.
const GRAPH_API = "https://graph.facebook.com/v23.0";

// ───────────────────────────────────────────────────────────────────────────
// CREATIVE SELECTION — placement/date-aware.
//
// For the live-creative visual check Vera reads the rule-filtered
// asset_feed_spec image pool and tags each image with the placement(s) it
// serves and the date its asset label was created. It deliberately does NOT
// anchor to the effective_object_story_id (the last *published* post): on
// paused or edited-but-not-relaunched ads that post is frozen on the PREVIOUS
// promo's creative, which was the root cause of Vera reporting phantom "old
// creative". A genuinely stale asset instead surfaces as an explained finding
// via the date tagging below. (The original effective-post anchor lives in git
// history if it is ever needed again.)

// An asset more than this many days older than the NEWEST asset in the same ad
// is treated as a likely leftover from an earlier promo cycle and called out.
const STALE_ASSET_AGE_GAP_DAYS = 25;

// Diagnostic logging is gated behind QA_DEBUG so production logs stay quiet and
// never echo creative copy or model reasoning. Set QA_DEBUG=1 to re-enable.
const dbg: (...args: unknown[]) => void =
  process.env.QA_DEBUG === "1" ? console.log.bind(console) : () => {};

// ── Automated Rules ──────────────────────────────────────────────────────────

export type CampaignRule = {
  id: string;
  name: string;
  status: "ENABLED" | "DISABLED" | string;
  // Human-readable summary of what the rule does, e.g. "PAUSE if spend > $X"
  summary: string;
};

export type FetchRulesResult = {
  rules: CampaignRule[];
  error: string | null;
};

export async function fetchCampaignRules(
  campaignId: string,
  accessToken: string
): Promise<FetchRulesResult> {
  try {
    const url = `${GRAPH_API}/${campaignId}/adrules_library?fields=id,name,status,trigger,actions,filters&access_token=${accessToken}`;
    const res = await fetch(url, { signal: AbortSignal.timeout(8000), cache: "no-store" });
    const data = await res.json();

    if (data.error) {
      // Graceful degradation — rules are supplemental, not critical
      return { rules: [], error: data.error.message ?? "Could not fetch rules" };
    }

    const rules: CampaignRule[] = (data.data ?? []).map((r: {
      id: string;
      name?: string;
      status?: string;
      actions?: { type?: string; value?: unknown }[];
      trigger?: { type?: string };
      filters?: { field?: string; operator?: string; value?: unknown }[];
    }) => {
      // Build a plain-English summary from the rule fields
      const actionStr = (r.actions ?? [])
        .map((a) => a.type ?? "")
        .filter(Boolean)
        .join(", ") || "unknown action";
      const triggerStr = r.trigger?.type ?? "unknown trigger";
      const filterStr = (r.filters ?? [])
        .map((f) => `${f.field ?? ""} ${f.operator ?? ""} ${JSON.stringify(f.value ?? "")}`)
        .filter(Boolean)
        .join("; ");
      const summary = filterStr
        ? `${actionStr} when ${filterStr} (trigger: ${triggerStr})`
        : `${actionStr} (trigger: ${triggerStr})`;

      return {
        id: r.id,
        name: r.name ?? "Unnamed rule",
        status: r.status ?? "UNKNOWN",
        summary,
      };
    });

    return { rules, error: null };
  } catch (err) {
    return { rules: [], error: `Network error: ${(err as Error).message}` };
  }
}

// ─────────────────────────────────────────────────────────────────────────────

export type CampaignAd = {
  id: string;
  name: string;
  adsetId: string;
  adsetName: string;
  createdTime: string; // ISO timestamp the ad was created
  updatedTime: string; // ISO timestamp the ad was last edited
};

export type FetchAdsOptions = {
  // Optional ISO date (YYYY-MM-DD). When set, ads not touched since this date
  // are dropped. The filter runs on updated_time (falling back to created_time):
  // campaigns reused month over month typically EDIT existing ads for the new
  // promo rather than recreate them, so created_time stays months old —
  // filtering on it silently dropped exactly the ads that should be QA'd.
  sinceDate?: string;
};

export type FetchAdsResult = {
  ads: CampaignAd[];
  error: string | null;
  // Counts so the UI can tell the user what was skipped and why.
  totalFetched: number;
  skippedOld: number;
  // Human-readable campaign name, so the UI can show it next to the pasted ID.
  campaignName: string | null;
};

export type PlacementInfo = {
  automatic: boolean; // true = Advantage+ automatic placements — no explicit positions stored
  publisher_platforms: string[];
  facebook_positions: string[];
  instagram_positions: string[];
  messenger_positions: string[];
  audience_network_positions: string[];
};

export type ImageDimensions = {
  width: number;
  height: number;
};

// Authoritative inventory of the LIVE creative, computed from the full served
// asset pool BEFORE any visual-QA image cap is applied. The QA route compares
// completeness (which sizes/cards exist live vs approved) against this in code,
// instead of having the vision model infer presence/absence from the image set
// it was handed — which may be a capped sample. Without this, a live carousel
// whose pool exceeds the QA cap looks like it is "missing" the trailing sizes.
export type CreativeInventory = {
  isCarousel: boolean;
  cardCount: number; // configured carousel cards (0 for single-image ads)
  imageCount: number; // total live image assets served (pre-cap)
  sizes: { size: string; count: number }[]; // e.g. [{size:"1080x1080",count:4},{size:"1080x1920",count:4}]
  imagesSentForVisualQa: number; // how many image assets were actually attached for vision
  truncated: boolean; // imagesSentForVisualQa < imageCount (the cap dropped some)
};

export type FormatInfo = {
  placements: PlacementInfo | null;
  creativeDimensions: ImageDimensions[]; // all unique dimensions found across creative assets
  adFormats: string[]; // e.g. ["AUTOMATIC_FORMAT"] or ["SINGLE_IMAGE", "CAROUSEL"]
  // Per-card dimensions of the carousel's actually-configured cards
  // (object_story_spec child_attachments), in card order and NOT deduplicated —
  // this is what lets QA flag one odd-sized card among otherwise uniform cards.
  // Empty for non-carousel ads and asset-feed carousels without child_attachments.
  cardDimensions?: ImageDimensions[];
  // Unique dimensions across IMAGE assets only (videos excluded) — videos
  // legitimately ship at different resolutions than statics, so consistency
  // rules must not compare across the two.
  imageDimensions?: ImageDimensions[];
  // Authoritative live-creative inventory (see CreativeInventory). Used by the
  // QA route for a code-level completeness check.
  creativeInventory?: CreativeInventory;
};

/**
 * Plans which live creative images go to visual QA, and records what the live ad
 * actually contains. Pure (no I/O) so it is unit-testable and shared by the
 * fetch path. Two jobs:
 *   1. ORDER: carousel pools arrive grouped by size (all 1:1, then all 9:16), so
 *      a flat cap would drop one whole size. Round-robin across size buckets so
 *      that if the cap bites it keeps a balanced sample of every size.
 *   2. INVENTORY: counts cards and per-size assets from the FULL pool (pre-cap)
 *      and records how many were actually sent — the authoritative completeness
 *      record, so the model never infers a "missing" size from a capped sample.
 */
export function planQaImages<T extends { url?: string | null; width?: number; height?: number }>(
  candidates: T[],
  isCarousel: boolean,
  cardCount: number,
  maxImages: number
): { ordered: T[]; inventory: CreativeInventory } {
  const sizeKey = (c: { width?: number; height?: number }) =>
    c.width && c.height ? `${c.width}x${c.height}` : "unknown";

  const sizeCounts = new Map<string, number>();
  for (const c of candidates) sizeCounts.set(sizeKey(c), (sizeCounts.get(sizeKey(c)) ?? 0) + 1);

  let ordered = candidates;
  if (isCarousel) {
    const buckets = new Map<string, T[]>();
    for (const c of candidates) {
      const k = sizeKey(c);
      const b = buckets.get(k);
      if (b) b.push(c);
      else buckets.set(k, [c]);
    }
    const queues = Array.from(buckets.values());
    const out: T[] = [];
    for (let more = true; more; ) {
      more = false;
      for (const q of queues) {
        const next = q.shift();
        if (next) {
          out.push(next);
          more = true;
        }
      }
    }
    ordered = out;
  }

  const sendable = ordered.filter((c) => !!c.url).length;
  const imagesSent = Math.min(sendable, maxImages);
  const inventory: CreativeInventory = {
    isCarousel,
    cardCount,
    imageCount: candidates.length,
    sizes: Array.from(sizeCounts.entries()).map(([size, count]) => ({ size, count })),
    imagesSentForVisualQa: imagesSent,
    truncated: imagesSent < candidates.length,
  };
  return { ordered, inventory };
}

/**
 * Fetches all ads under a campaign ID from the Meta Graph API, following
 * pagination so campaigns with more than one page of ads are fully loaded.
 * A hard page cap prevents an unbounded loop on very large accounts; if the cap
 * is hit, whatever was collected is returned (a QA run on a partial set is
 * better than failing, and the cap is well above any realistic campaign size).
 */
const MAX_AD_PAGES = 10; // 10 pages × 200 = up to 2000 ads

// Resolves a campaign ID to its name. Best-effort — a failure just means the
// UI shows the bare ID, so errors are swallowed rather than failing the load.
async function fetchCampaignName(campaignId: string, accessToken: string): Promise<string | null> {
  try {
    const url = `${GRAPH_API}/${campaignId}?fields=name&access_token=${accessToken}`;
    const res = await fetch(url, { signal: AbortSignal.timeout(8000), cache: "no-store" });
    const data = await res.json();
    if (data.error || !data.name) return null;
    return data.name as string;
  } catch {
    return null;
  }
}

export async function fetchCampaignAdsList(
  campaignId: string,
  accessToken: string,
  options: FetchAdsOptions = {}
): Promise<FetchAdsResult> {
  // A campaign reused month over month accumulates ad sets from past promos;
  // without a date floor those get QA'd against the current work order and
  // report false fails. The cutoff compares against updated_time (when the ad
  // was last edited) so ads refreshed in place for the current promo survive,
  // while genuinely untouched past-promo ads are dropped.
  const sinceMs = options.sinceDate ? Date.parse(options.sinceDate) : NaN;
  const hasSince = !Number.isNaN(sinceMs);

  let url: string | null =
    `${GRAPH_API}/${campaignId}/ads?fields=id,name,adset{id,name},created_time,updated_time&limit=200&access_token=${accessToken}`;
  const ads: CampaignAd[] = [];
  let totalFetched = 0;
  let skippedOld = 0;

  // Resolve the campaign's name in parallel with the ads pages — purely
  // cosmetic, so it never blocks or fails the ad load.
  const campaignNamePromise = fetchCampaignName(campaignId, accessToken);

  try {
    for (let page = 0; url && page < MAX_AD_PAGES; page++) {
      const res: Response = await fetch(url, { signal: AbortSignal.timeout(10000), cache: "no-store" });
      const data: {
        data?: {
          id: string;
          name: string;
          adset?: { id?: string; name?: string };
          created_time?: string;
          updated_time?: string;
        }[];
        paging?: { next?: string };
        error?: { code?: number; message?: string };
      } = await res.json();

      if (data.error) {
        const code = data.error.code;
        const msg = data.error.message ?? "Unknown Meta API error";
        let friendly = `Meta API error (code ${code}): ${msg}`;
        if (code === 190) friendly = `Access token invalid or expired. Regenerate META_ACCESS_TOKEN.`;
        else if (code === 100) friendly = `Invalid campaign ID or bad request. Check the ID and try again.`;
        else if (code === 200) friendly = `Token missing required permissions (needs ads_read or ads_management).`;
        return { ads: [], error: friendly, totalFetched, skippedOld, campaignName: await campaignNamePromise };
      }

      for (const ad of data.data ?? []) {
        totalFetched++;
        const createdTime = ad.created_time ?? "";
        const updatedTime = ad.updated_time ?? "";

        // Drop ads not touched since the cutoff date when one is set.
        // updated_time is the signal (edits for the current promo refresh it);
        // fall back to created_time only if updated_time is absent.
        if (hasSince) {
          const refTime = updatedTime || createdTime;
          const refMs = refTime ? Date.parse(refTime) : NaN;
          if (Number.isNaN(refMs) || refMs < sinceMs) {
            skippedOld++;
            continue;
          }
        }

        ads.push({
          id: ad.id,
          name: ad.name,
          adsetId: ad.adset?.id ?? "",
          adsetName: ad.adset?.name ?? "",
          createdTime,
          updatedTime,
        });
      }

      // Follow the cursor Meta returns; absent when there are no more pages.
      url = data.paging?.next ?? null;
    }

    return { ads, error: null, totalFetched, skippedOld, campaignName: await campaignNamePromise };
  } catch (err) {
    return { ads: [], error: `Network error: ${(err as Error).message}`, totalFetched, skippedOld, campaignName: null };
  }
}

/**
 * Resolves a Meta preview URL to an ad/creative ID.
 * Handles:
 *   - Numeric IDs pasted directly: 120210001234567
 *   - Ads Manager URLs with ?id= param: facebook.com/ads/preview/?id=XXXXX
 * Note: fb.me short links cannot be resolved (no ad ID is extractable) — returns null.
 */
export async function resolveAdId(input: string): Promise<string | null> {
  const trimmed = input.trim();

  // Already a numeric ID (most reliable — paste straight from Ads Manager)
  if (/^\d{10,}$/.test(trimmed)) return trimmed;

  try {
    const urlStr = trimmed.startsWith("http") ? trimmed : `https://${trimmed}`;
    const url = new URL(urlStr);

    // fb.me/adspreview/ — opaque token, no ad ID extractable
    if (url.hostname === "fb.me" || url.hostname.endsWith(".fb.me")) {
      return null;
    }

    // Standard query params: ?id=, ?ad_id=, ?selected_ad_ids=
    const fromParams =
      url.searchParams.get("id") ||
      url.searchParams.get("ad_id") ||
      url.searchParams.get("creative_id") ||
      url.searchParams.get("selected_ad_ids");
    if (fromParams) {
      const candidate = fromParams.split(",")[0].trim();
      // Meta IDs are numeric. Reject anything else so it can never be
      // concatenated into a Graph API URL path/query.
      return /^\d{6,}$/.test(candidate) ? candidate : null;
    }

    return null;
  } catch {
    return null;
  }
}

type EnrollStatus = "OPT_IN" | "OPT_OUT" | string;
type CreativeFeatureEntry = { enroll_status?: EnrollStatus };

type DegreesOfFreedomSpec = {
  creative_features_spec?: {
    // Confirmed fields (Meta API docs explicitly state their Ads Manager UI label)
    image_templates?: CreativeFeatureEntry;          // "Add Overlays"
    image_touchups?: CreativeFeatureEntry;           // "Visual Touch Ups" (image ads)
    video_auto_crop?: CreativeFeatureEntry;          // "Visual Touch Ups" (video ads)
    text_optimizations?: CreativeFeatureEntry;       // "Text Improvements"
    image_brightness_and_contrast?: CreativeFeatureEntry; // "Adjust Brightness & Contrast"
    reveal_details_over_time?: CreativeFeatureEntry; // "Reveal Details Over Time"
    text_translation?: CreativeFeatureEntry;         // "Translations"
    add_text_overlay?: CreativeFeatureEntry;         // "Add Dynamic Overlays"
    inline_comment?: CreativeFeatureEntry;           // "Relevant Comments"
    enhance_cta?: CreativeFeatureEntry;              // "Enhance CTA"
    image_uncrop?: CreativeFeatureEntry;             // "Expand Image"
    // Fields present in API — UI label not confirmed in docs
    show_summary?: CreativeFeatureEntry;
    site_extensions?: CreativeFeatureEntry;
    biz_ai?: CreativeFeatureEntry;
    replace_media_text?: CreativeFeatureEntry;
    image_animation?: CreativeFeatureEntry;
    video_highlights?: CreativeFeatureEntry;
    profile_card?: CreativeFeatureEntry;
    // Legacy — kept for backward compat with older ads
    standard_enhancements?: CreativeFeatureEntry;
    [key: string]: CreativeFeatureEntry | undefined;
  };
};

export type AiEnhancement = {
  key: string;
  label: string;
  status: "on" | "off";
};

// Confirmed: Meta API docs explicitly state these Ads Manager UI labels
// Unconfirmed: field name strongly matches the UI label but no doc confirmation found
const ENHANCEMENT_LABELS: Record<string, string> = {
  // Confirmed
  image_templates: "Add Overlays",
  image_touchups: "Visual Touch Ups",
  video_auto_crop: "Visual Touch Ups (video)",
  text_optimizations: "Text Improvements",
  image_brightness_and_contrast: "Adjust Brightness & Contrast",
  reveal_details_over_time: "Reveal Details Over Time",
  text_translation: "Translations",
  add_text_overlay: "Add Dynamic Overlays",
  inline_comment: "Relevant Comments",
  enhance_cta: "Enhance CTA",
  image_uncrop: "Expand Image",
  // Unconfirmed label
  show_summary: "Show Summaries",
  site_extensions: "Site Links",
  biz_ai: "Add Business AI",
  replace_media_text: "Enhance Media Text",
  image_animation: "Add Animation",
  video_highlights: "Show Spotlights",
  profile_card: "Profile End Card",
  // Legacy
  standard_enhancements: "Standard Enhancements (legacy)",
  // Unconfirmed — seen in API responses, UI label not verified
  ads_with_benefits: "Ads with Benefits",
  advantage_plus_creative: "Advantage+ Creative",
  carousel_to_video: "Carousel to Video",
  cv_transformation: "Creative Variations",
  pac_relaxation: "PAC Relaxation",
  product_extensions: "Product Extensions",
  show_destination_blurbs: "Destination Blurbs",
  video_filtering: "Video Filtering",
  video_uncrop: "Expand Video",
};

// Confirmed user-controllable enhancement toggles. If one of these keys is
// ABSENT from degrees_of_freedom_spec, Meta simply did not report its state —
// and several Advantage+ features default to opt-IN unless explicitly opted
// out, so absence must surface as "verify manually", never as implicitly off.
// (inline_comment is excluded: it's allowed ON by policy either way.)
const CONFIRMED_ENHANCEMENT_KEYS = [
  "image_templates",
  "image_touchups",
  "video_auto_crop",
  "text_optimizations",
  "image_brightness_and_contrast",
  "reveal_details_over_time",
  "text_translation",
  "add_text_overlay",
  "enhance_cta",
  "image_uncrop",
];

// Keys the Meta API reports as OPT_IN but that don't correspond to a user-controllable
// toggle visible in Ads Manager. Excluding these from API-checked enhancements prevents
// false positives. They are moved to MANUAL_CHECK_ITEMS instead.
const UNRELIABLE_API_KEYS = new Set([
  "translate_voiceover",
]);

// Enhancements that are intentionally always left ON and should NOT be flagged by QA.
// They still appear in the enhancements list (marked "allowed"), but being ON does not
// trigger a warning/critical flag.
export const ALLOWED_ENHANCEMENT_KEYS = new Set<string>([
  "inline_comment", // "Relevant Comments" — always on by policy
]);

// Items from the QA checklist that have no reliable API field in degrees_of_freedom_spec.
// These must be verified manually inside Meta Ads Manager.
export const MANUAL_CHECK_ITEMS: string[] = [
  "Website Summary",
  "Promotions",
  "Website Highlights",
  "Products (Creative Set-Up)",
  "Adapt Multi-Image Format",
  "Add Product Tags",
  "Highlight Carousel Card (carousel only)",
  "Related Media",
  "Personalized Destinations",
];

type CreativeFields = {
  id?: string;
  name?: string;
  body?: string;
  title?: string;
  call_to_action_type?: string;
  link_url?: string;
  image_hash?: string;
  effective_object_story_id?: string; // the actually-serving published post
  image_url?: string; // primary serving image, when populated
  degrees_of_freedom_spec?: DegreesOfFreedomSpec;
  object_story_spec?: {
    link_data?: {
      message?: string;
      name?: string;
      description?: string;
      link?: string;
      caption?: string;
      image_hash?: string;
      call_to_action?: {
        type?: string;
        value?: { link?: string };
      };
      child_attachments?: Array<{
        name?: string;
        description?: string;
        link?: string;
        call_to_action?: { type?: string; value?: { link?: string } };
        image_hash?: string; // the configured card image — ground truth for a carousel card
        picture?: string;    // viewable URL for the card, when image_hash isn't resolvable
        video_id?: string;   // present when the card is a VIDEO (image_hash is then just the cover frame)
      }>;
    };
    video_data?: {
      message?: string;
      title?: string;
      video_id?: string;
      call_to_action?: {
        type?: string;
        value?: { link?: string };
      };
    };
  };
  asset_feed_spec?: {
    bodies?: Array<{ text?: string }>;
    titles?: Array<{ text?: string; adlabels?: Array<{ name?: string }> }>;
    descriptions?: Array<{ text?: string }>; // card/link descriptions for asset-feed ads — without this, QA falsely reports approved descriptions as "absent from live ad"
    call_to_action_types?: string[];
    link_urls?: Array<{ website_url?: string }>;
    images?: Array<{ hash?: string; url?: string; adlabels?: Array<{ name?: string }> }>; // width/height not a valid sub-field — use AdImages endpoint
    videos?: Array<{ video_id?: string; url?: string; thumbnail_url?: string }>;
    audios?: Array<{ type?: string }>; // non-empty = Add Music is ON (music lives here, not in degrees_of_freedom_spec)
    ad_formats?: string[];
    optimization_type?: string; // ASSET_CUSTOMIZATION | PLACEMENT | LANGUAGE | REGULAR | FORMAT_AUTOMATION
    // Maps which asset actually serves for which placement. Only images referenced
    // by a rule are live; images present in images[] but referenced by NO rule are
    // stale leftovers from an earlier edit (the source of the phantom "April" reads).
    asset_customization_rules?: Array<{
      image_label?: { name?: string };
      customization_spec?: Record<string, unknown>;
      priority?: number;
    }>;
  };
};

type AdResponse = {
  id?: string;
  name?: string;
  adset_id?: string;
  account_id?: string;
  creative?: CreativeFields;
  error?: { message?: string; code?: number; fbtrace_id?: string };
};

// Per-image context for the visual QA. Aligned by `url` to creativeImageUrls.
export type CreativeImageContext = {
  url: string;
  placement: string | null;   // human-readable placement(s) this asset serves, when resolvable
  assetDate: string | null;   // ISO date the asset label was created, when resolvable
  staleNote: string | null;   // set when this asset is much older than the newest in the ad
  // true when this URL is a video's auto-selected thumbnail — ONE frame of the
  // video, not the creative itself, so the QA prompt can treat frame-vs-frame
  // text differences as non-findings.
  videoThumbnail?: boolean;
};

export type FetchResult = {
  content: string | null;
  error: string | null;
  aiEnhancements: AiEnhancement[] | null;
  formatInfo: FormatInfo | null; // null only on hard API error
  creativeImageUrls: string[]; // image/thumbnail URLs for visual QA
  creativeImageContext: CreativeImageContext[]; // per-image placement/date tags
  manualCheckItems: string[]; // checklist items that cannot be read from the API — must be verified in Ads Manager
};

/**
 * Fetches placement targeting from an ad set.
 */
async function fetchAdsetPlacements(adsetId: string, accessToken: string): Promise<PlacementInfo | null> {
  try {
    const url = `${GRAPH_API}/${adsetId}?fields=targeting&access_token=${accessToken}`;
    const res = await fetch(url, { signal: AbortSignal.timeout(8000), cache: "no-store" });
    const data = await res.json();
    if (data.error || !data.targeting) return null;
    const t = data.targeting;
    const platforms: string[] = t.publisher_platforms ?? [];
    const fbPositions: string[] = t.facebook_positions ?? [];
    const igPositions: string[] = t.instagram_positions ?? [];
    const msPositions: string[] = t.messenger_positions ?? [];
    const anPositions: string[] = t.audience_network_positions ?? [];
    // If no explicit positions, this adset uses Advantage+ automatic placements
    const automatic = platforms.length === 0 && fbPositions.length === 0 && igPositions.length === 0;
    return {
      automatic,
      publisher_platforms: platforms,
      facebook_positions: fbPositions,
      instagram_positions: igPositions,
      messenger_positions: msPositions,
      audience_network_positions: anPositions,
    };
  } catch {
    return null;
  }
}

type ImageMeta = ImageDimensions & { url?: string };

/**
 * Batch-fetches image metadata (dimensions + a viewable URL) from the AdImages
 * endpoint using multiple hashes. Returns a map of hash → { width, height, url }.
 *
 * The `url` is a temporary Meta CDN link to the full image — used to feed
 * hash-based single-image ads (object_story_spec / top-level image_hash) into the
 * visual QA check, which otherwise only sees URLs from asset_feed_spec.
 */
async function fetchBatchImageDimensions(
  accountId: string,
  hashes: string[],
  accessToken: string
): Promise<Map<string, ImageMeta>> {
  const result = new Map<string, ImageMeta>();
  if (hashes.length === 0) return result;
  try {
    const hashParam = encodeURIComponent(JSON.stringify(hashes));
    const url = `${GRAPH_API}/act_${accountId}/adimages?hashes=${hashParam}&fields=width,height,hash,url,permalink_url&access_token=${accessToken}`;
    const res = await fetch(url, { signal: AbortSignal.timeout(10000), cache: "no-store" });
    const data = await res.json();
    if (data.error || !data.data?.length) return result;
    for (const img of data.data as Array<{ hash?: string; width?: number; height?: number; url?: string; permalink_url?: string }>) {
      if (img.hash && img.width && img.height) {
        result.set(img.hash, { width: img.width, height: img.height, url: img.url ?? img.permalink_url });
      }
    }
  } catch {
    // ignore — dimensions just won't be available
  }
  return result;
}

/**
 * Fetches video dimensions from the Video object using a video ID.
 * Uses the "format" field which returns an array of renditions — we pick the largest (original).
 */
async function fetchVideoDimensions(videoId: string, accessToken: string): Promise<(ImageDimensions & { thumbnailUrl?: string }) | null> {
  try {
    const url = `${GRAPH_API}/${videoId}?fields=format,picture&access_token=${accessToken}`;
    const res = await fetch(url, { signal: AbortSignal.timeout(8000), cache: "no-store" });
    const data = await res.json();
    if (data.error || !data.format?.length) return null;
    type VideoFormat = { filter?: string; width?: number; height?: number };
    const formats = data.format as VideoFormat[];
    // Prefer the "default" rendition; fall back to the largest by area
    const original =
      formats.find((f) => f.filter === "default") ??
      formats.reduce((best, f) =>
        (f.width ?? 0) * (f.height ?? 0) > (best.width ?? 0) * (best.height ?? 0) ? f : best
      , formats[0]);
    if (!original?.width || !original?.height) return null;
    return { width: original.width, height: original.height, thumbnailUrl: typeof data.picture === "string" ? data.picture : undefined };
  } catch {
    return null;
  }
}

/**
 * Fetches the "Add Music" status by reading asset_feed_spec.audios in isolation.
 *
 * This field must be requested on its own: for ads that use a track from Meta's licensed
 * music collection, `audios` returns (#100) Missing Permission, and Graph fails an entire
 * request if any single requested field is forbidden. Isolating it here means a forbidden
 * `audios` field degrades to "unknown" instead of failing the whole creative read.
 *
 * Returns:
 *   "on"      — asset_feed_spec present and contains at least one audio track
 *   "off"     — asset_feed_spec present with no audio tracks
 *   "unknown" — field forbidden (#100), errored, or no asset_feed_spec to read
 */
async function fetchMusicStatus(
  adId: string,
  accessToken: string
): Promise<"on" | "off" | "unknown"> {
  try {
    const url = `${GRAPH_API}/${adId}?fields=creative{asset_feed_spec{audios{type}}}&access_token=${accessToken}`;
    const res = await fetch(url, { signal: AbortSignal.timeout(8000), cache: "no-store" });
    const data = await res.json();
    if (data.error) return "unknown";
    const afs = data.creative?.asset_feed_spec;
    if (afs === undefined) return "unknown"; // no asset_feed_spec — can't distinguish off from absent
    return (afs.audios?.length ?? 0) > 0 ? "on" : "off";
  } catch {
    return "unknown";
  }
}

// ─── Placement/date-aware helpers ───────────────────────────────────────────

// Asset labels are named like "placement_asset_<hex>_<unixMillis>". The trailing
// number is the millisecond timestamp the asset/label was created. Returns that
// epoch-ms value, or null if the name doesn't carry one.
function assetLabelDateMs(labelName: string | undefined | null): number | null {
  if (!labelName) return null;
  const m = labelName.match(/_(\d{13})(?:$|\D)/); // 13-digit ms timestamp
  if (!m) return null;
  const ms = Number(m[1]);
  return Number.isFinite(ms) ? ms : null;
}

// Turns a customization_spec (the placement targeting on an asset_customization_rule)
// into a short human-readable placement description, e.g. "Instagram: story, reels".
function describePlacement(spec: Record<string, unknown> | undefined): string | null {
  if (!spec) return null;
  const parts: string[] = [];
  const pp = (spec.publisher_platforms as string[] | undefined) ?? [];
  const fb = (spec.facebook_positions as string[] | undefined) ?? [];
  const ig = (spec.instagram_positions as string[] | undefined) ?? [];
  const ms = (spec.messenger_positions as string[] | undefined) ?? [];
  const an = (spec.audience_network_positions as string[] | undefined) ?? [];
  if (fb.length) parts.push(`Facebook: ${fb.join(", ")}`);
  if (ig.length) parts.push(`Instagram: ${ig.join(", ")}`);
  if (ms.length) parts.push(`Messenger: ${ms.join(", ")}`);
  if (an.length) parts.push(`Audience Network: ${an.join(", ")}`);
  if (!parts.length && pp.length) parts.push(pp.join(", "));
  if (!parts.length) return "default / all remaining placements";
  return parts.join("; ");
}

type AssetFeedSpecLike = NonNullable<CreativeFields["asset_feed_spec"]>;

// Builds a map of image-hash → { placements, dateMs } from asset_feed_spec.
// Placement comes from whichever asset_customization_rule references the image's
// label (statics: image_label; carousels: image_label on child_attachments).
// dateMs comes from the image's own adlabel name timestamp.
function buildHashContext(
  feed: AssetFeedSpecLike | undefined
): Map<string, { placements: string[]; dateMs: number | null }> {
  const ctx = new Map<string, { placements: string[]; dateMs: number | null }>();
  if (!feed) return ctx;

  // label name → image hash (an image can carry several labels)
  const labelToHash = new Map<string, string>();
  for (const img of feed.images ?? []) {
    if (!img.hash) continue;
    let dateMs: number | null = null;
    for (const l of img.adlabels ?? []) {
      if (l.name) {
        labelToHash.set(l.name, img.hash);
        dateMs = dateMs ?? assetLabelDateMs(l.name);
      }
    }
    if (!ctx.has(img.hash)) ctx.set(img.hash, { placements: [], dateMs });
  }

  // Walk customization rules; attach the rule's placement to the image its
  // image_label points at. Carousel rules use carousel_label (a card set, not a
  // single image) so we can't map them to one hash — those just keep their date.
  for (const rule of feed.asset_customization_rules ?? []) {
    const labelName = (rule.image_label as { name?: string } | undefined)?.name;
    if (!labelName) continue;
    const hash = labelToHash.get(labelName);
    if (!hash) continue;
    const placement = describePlacement(rule.customization_spec as Record<string, unknown> | undefined);
    const entry = ctx.get(hash);
    if (entry && placement && !entry.placements.includes(placement)) {
      entry.placements.push(placement);
    }
  }

  return ctx;
}

/**
 * Fetches ad creative content from the Meta Graph API.
 * Returns the formatted content, AI enhancement statuses, format info, and
 * a list of checklist items that must be verified manually in Ads Manager.
 */
export async function fetchAdContent(
  adId: string,
  accessToken: string
): Promise<FetchResult> {
  const fields = [
    "adset_id",
    "account_id",
    "name",
    // NOTE: asset_feed_spec.audios is intentionally NOT requested here. For ads that use a
    // track from Meta's licensed music collection, reading `audios` returns (#100) Missing
    // Permission, and because Graph fails the whole request on a single forbidden field, that
    // one field would fail the entire ad read. Music status is fetched separately in
    // fetchMusicStatus() so it degrades to "unknown" instead of nuking the creative read.
    "creative{body,title,call_to_action_type,link_url,name,image_hash,effective_object_story_id,image_url,object_story_spec{link_data{message,name,description,link,caption,image_hash,call_to_action,child_attachments{name,description,link,call_to_action,image_hash,picture}},video_data{message,title,video_id,call_to_action}},asset_feed_spec{bodies{text},titles{text,adlabels{name}},descriptions{text},call_to_action_types,link_urls{website_url},images{hash,url,adlabels{name}},videos{video_id,thumbnail_url},ad_formats,optimization_type,asset_customization_rules{image_label{name},customization_spec,priority}},degrees_of_freedom_spec}",
  ].join(",");

  const url = `${GRAPH_API}/${adId}?fields=${encodeURIComponent(fields)}&access_token=${accessToken}`;

  const fetchStart = Date.now();

  let data: AdResponse;
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(10000), cache: "no-store" });
    data = await res.json();
  } catch (err) {
    return { content: null, error: `Network error contacting Meta API: ${(err as Error).message}`, aiEnhancements: null, formatInfo: null, creativeImageUrls: [], creativeImageContext: [], manualCheckItems: MANUAL_CHECK_ITEMS };
  }

  if (data.error) {
    const errorLabel = data.error.code === 100 ? "MISSING_PERMISSION"
      : data.error.code === 190 ? "INVALID_TOKEN"
      : data.error.code === 12  ? "BAD_AD_ID"
      : `CODE_${data.error.code}`;
    console.error(`[meta-api] [${errorLabel}] ad=${adId} elapsed_ms=${Date.now() - fetchStart} fbtrace_id=${data.error.fbtrace_id ?? "n/a"} | ${data.error.message}`);
    const code = data.error.code;
    const msg = data.error.message ?? "Unknown Meta API error";

    // Translate common error codes into actionable messages
    let friendly = `Meta API error (code ${code}): ${msg}`;
    if (code === 12) {
      friendly =
        `Meta returned error #12 for ID ${adId}. Most likely cause: the token's user/system user does not have access to this ad's ad account, or the ID is not actually an Ad ID (could be a post/creative/campaign ID). Original message: ${msg}`;
    } else if (code === 190) {
      friendly = `Access token is invalid or expired. Regenerate META_ACCESS_TOKEN. Original: ${msg}`;
    } else if (code === 100) {
      friendly = `Permission denied for ad ${adId} (Meta code 100). This usually means the token's user does not have access to this ad's ad account in Business Manager. Verify the account is shared with the token owner, or that the correct access token is being used. Original: ${msg}`;
    } else if (code === 200) {
      friendly = `Token is missing required permissions (need ads_read or ads_management). Original: ${msg}`;
    }

    return { content: null, error: friendly, aiEnhancements: null, formatInfo: null, creativeImageUrls: [], creativeImageContext: [], manualCheckItems: MANUAL_CHECK_ITEMS };
  }

  const formatted = formatCreative(data);
  let aiEnhancements = parseAiEnhancements(data.creative?.degrees_of_freedom_spec);

  // Fetch placement data and creative dimensions in parallel where possible
  const adsetId = data.adset_id;
  const accountId = data.account_id;

  // Collect all image hashes from asset_feed_spec (batch lookup) + fallback locations
  const feedHashes = (data.creative?.asset_feed_spec?.images ?? [])
    .map((img) => img.hash)
    .filter(Boolean) as string[];
  const singleHash =
    data.creative?.image_hash ??
    data.creative?.object_story_spec?.link_data?.image_hash;
  // Carousel card image hashes — the actually-configured cards. Resolving these
  // to viewable URLs lets us QA the real cards instead of the asset_feed_spec
  // pool (which retains stale assets from earlier creative edits).
  const cardHashes = (data.creative?.object_story_spec?.link_data?.child_attachments ?? [])
    .map((c) => c.image_hash)
    .filter(Boolean) as string[];
  const allHashes = Array.from(new Set([...feedHashes, ...cardHashes, ...(singleHash ? [singleHash] : [])]));

  const feedVideoIds = (data.creative?.asset_feed_spec?.videos ?? [])
    .map((v) => v.video_id)
    .filter(Boolean) as string[];
  const singleVideoId = data.creative?.object_story_spec?.video_data?.video_id;
  const allVideoIds = Array.from(new Set([...feedVideoIds, ...(singleVideoId ? [singleVideoId] : [])]));

  const [placements, dimMap, videoDims, musicStatus] = await Promise.all([
    adsetId ? fetchAdsetPlacements(adsetId, accessToken) : Promise.resolve(null),
    accountId && allHashes.length > 0
      ? fetchBatchImageDimensions(accountId, allHashes, accessToken)
      : Promise.resolve(new Map<string, ImageMeta>()),
    allVideoIds.length > 0
      ? Promise.all(allVideoIds.map((id) => fetchVideoDimensions(id, accessToken)))
      : Promise.resolve([] as ((ImageDimensions & { thumbnailUrl?: string }) | null)[]),
    fetchMusicStatus(adId, accessToken),
  ]);

  // Music ("Add Music") is read in its own request because the asset_feed_spec.audios field
  // returns (#100) for ads using licensed music and would otherwise fail the whole creative
  // read. Only surface it when we could actually determine on/off — "unknown" is dropped so
  // the QA model treats it as a manual-check item rather than a false "off".
  if (musicStatus !== "unknown") {
    const musicEntry: AiEnhancement = { key: "music", label: "Add Music", status: musicStatus };
    aiEnhancements = aiEnhancements ? [...aiEnhancements, musicEntry] : [musicEntry];
  }

  // Deduplicate by WxH
  const seenSizes = new Set<string>();
  const creativeDimensions: ImageDimensions[] = [];
  function addDim(d: ImageDimensions | null | undefined) {
    if (!d?.width || !d?.height) return;
    const key = `${d.width}x${d.height}`;
    if (!seenSizes.has(key)) { seenSizes.add(key); creativeDimensions.push(d); }
  }
  for (const hash of allHashes) addDim(dimMap.get(hash));
  // Image-only snapshot BEFORE video dims are mixed in — consistency checks
  // must not compare image sizes against video renditions.
  const imageDimensions: ImageDimensions[] = [...creativeDimensions];
  for (const d of videoDims) addDim(d);

  const adFormats = data.creative?.asset_feed_spec?.ad_formats ?? [];

  // Per-card dims for the configured carousel cards (order preserved, no dedup)
  // so the QA route can flag a single odd-sized card among uniform siblings.
  // FIX #4: exclude VIDEO cards. A video card's image_hash is only its cover
  // frame, which legitimately ships at a different resolution than sibling
  // static cards — including it made the carousel-uniformity check hard-FAIL a
  // perfectly valid mixed image+video carousel. Uniformity is judged across
  // IMAGE cards only (mirrors the imageDimensions-vs-videoDims split above).
  const imageCardHashes = (data.creative?.object_story_spec?.link_data?.child_attachments ?? [])
    .filter((c) => !c.video_id && c.image_hash)
    .map((c) => c.image_hash as string);
  const cardDimensions: ImageDimensions[] = imageCardHashes
    .map((h) => dimMap.get(h))
    .filter((d): d is ImageMeta => !!d?.width && !!d?.height)
    .map(({ width, height }) => ({ width, height }));

  const formatInfo: FormatInfo = { placements, creativeDimensions, adFormats, cardDimensions, imageDimensions };

  // --- Select which creative images to send for visual QA -----------------
  // A single-image ad serves ONE creative, but its asset_feed_spec.images pool
  // can still contain several assets: legitimate per-placement SIZE variants
  // (1:1, 4:5, 9:16) AND stale leftovers from earlier creative edits. OCR'ing
  // the stale ones makes the model report offers/dates that are not in the live
  // ad — the "text nowhere to be found" false positives. Carousels genuinely
  // have many images (their cards), so they must NOT be collapsed.
  //
  // Fix: for non-carousel ads, dedupe candidate images by exact WxH. Distinct
  // sizes (all current) are kept; same-size duplicates (the stale smell)
  // collapse to one, preferring the concrete published image when present.
  const isCarousel =
    !!data.creative?.object_story_spec?.link_data?.child_attachments?.length ||
    adFormats.some((f) => f.toUpperCase().includes("CAROUSEL"));

  // --- Drop stale (un-served) pool assets via asset_customization_rules ----
  // The effective-post / image_url anchors return nothing on these dynamic
  // PLACEMENT ads, so we still landed on the stale pool. asset_customization_rules
  // are Meta's own map of which image serves for which placement (by image
  // label). An image present in images[] but referenced by NO rule is a stale
  // leftover from an earlier edit — exactly the old "April" assets. When rules
  // exist AND images carry labels, keep only the live (rule-referenced) images.
  const rawFeedImages = data.creative?.asset_feed_spec?.images ?? [];
  const customizationRules = data.creative?.asset_feed_spec?.asset_customization_rules ?? [];
  const liveLabels = new Set(
    customizationRules.map((r) => r.image_label?.name).filter(Boolean) as string[]
  );
  const imgLabelNames = (img: { adlabels?: Array<{ name?: string }> }) =>
    (img.adlabels ?? []).map((l) => l.name).filter(Boolean) as string[];
  const anyImageLabeled = rawFeedImages.some((img) => imgLabelNames(img).length > 0);
  const liveImageHashes = new Set<string>();
  if (liveLabels.size > 0 && anyImageLabeled) {
    for (const img of rawFeedImages) {
      if (img.hash && imgLabelNames(img).some((n) => liveLabels.has(n))) liveImageHashes.add(img.hash);
    }
  }
  // Only apply the filter when it confidently identifies ≥1 live image — never
  // narrow to empty (that would drop the whole comparison).
  const rulesFilterActive = liveImageHashes.size > 0;

  type ImgCandidate = { url: string; hash?: string; width?: number; height?: number; dateMs?: number | null };
  const feedImageCandidates: ImgCandidate[] = [];
  for (const img of rawFeedImages) {
    // Skip assets the customization rules don't reference — stale leftovers.
    if (rulesFilterActive && (!img.hash || !liveImageHashes.has(img.hash))) continue;
    const dims = img.hash ? dimMap.get(img.hash) : undefined;
    const url = img.url ?? dims?.url;
    // The asset's creation date, parsed from its adlabel name (..._<unixMillis>).
    // Used to prefer the newest asset per size so an old-promo leftover sharing a
    // size with the current asset doesn't win the bucket.
    const dateMs = (img.adlabels ?? [])
      .map((l) => assetLabelDateMs(l.name))
      .find((d): d is number => d != null) ?? null;
    if (url) feedImageCandidates.push({ url, hash: img.hash, width: dims?.width, height: dims?.height, dateMs });
  }
  // Hash-based single-image ads (object_story_spec / top-level image_hash) carry no URL
  // in the creative spec — pull the viewable URL resolved from the AdImages endpoint so
  // these statics still get a visual check.
  for (const hash of allHashes) {
    const dims = dimMap.get(hash);
    if (dims?.url && !feedImageCandidates.some((c) => c.hash === hash)) {
      feedImageCandidates.push({ url: dims.url, hash, width: dims.width, height: dims.height });
    }
  }

  const publishedHash = singleHash; // the concrete published image, when the ad has one

  let chosenImageCandidates: ImgCandidate[];
  if (isCarousel) {
    chosenImageCandidates = feedImageCandidates; // keep every card
  } else {
    // Dedupe by exact WxH. Within a size bucket prefer the published image, then
    // the NEWEST-dated asset — the fix for an old-promo static (e.g. an "April"
    // 1080x1080) winning its size bucket over the current June asset just because
    // it appears first in the pool.
    const bySize = new Map<string, ImgCandidate>();
    const unknownDim: ImgCandidate[] = [];
    for (const c of feedImageCandidates) {
      if (c.width && c.height) {
        const key = `${c.width}x${c.height}`;
        const existing = bySize.get(key);
        if (!existing) {
          bySize.set(key, c);
        } else if (publishedHash && c.hash === publishedHash) {
          bySize.set(key, c);
        } else if (
          !(publishedHash && existing.hash === publishedHash) &&
          (c.dateMs ?? -Infinity) > (existing.dateMs ?? -Infinity)
        ) {
          bySize.set(key, c);
        }
      } else {
        unknownDim.push(c);
      }
    }
    chosenImageCandidates = [...Array.from(bySize.values()), ...unknownDim];

    // NOTE: We intentionally do NOT apply a cross-size stale-date filter here.
    // A previous version dropped any unique-size asset dated 25+ days behind the
    // newest asset in the pool, intending to catch old-promo Reels left in the
    // asset_feed_spec. In practice it caused false GENUINE GAP reports: a multi-
    // format ad (e.g. 1080×1080 for Feed from June + 1080×1920 for Stories from
    // July) would have the older size silently dropped because June is ~30 days
    // behind July — over the threshold — even though both sizes are actively
    // serving. After WxH dedup, each size bucket already has exactly one
    // representative (the newest same-size asset), so there's no same-size
    // duplicate to remove. Stale unique-size leftovers are still surfaced via
    // the per-image staleNote in creativeImageContext so the model can flag them.
  }

  // --- Select the live creative images ------------------------------------
  // Vera reads the rule-filtered, date-deduped asset pool built above rather
  // than anchoring to the effective published post: on paused or edited-but-
  // not-relaunched ads that post is frozen on the PREVIOUS promo's creative,
  // which produced phantom "old creative" findings. Each chosen image is tagged
  // below with the placement it serves and its asset date, so a genuinely stale
  // asset surfaces as an explained finding instead.
  const liveSource = isCarousel ? "pool_placement_aware_carousel" : "pool_placement_aware";

  // Diagnostic (gated behind QA_DEBUG): which stale-asset signals were present.
  dbg(
    `[meta-api][stale-dbg] ad=${adId} ` +
      `rules=${customizationRules.length} ` +
      `labeled_images=${rawFeedImages.filter((i) => imgLabelNames(i).length).length}/${rawFeedImages.length} ` +
      `live_hashes=${liveImageHashes.size} rules_filter_active=${rulesFilterActive}`
  );

  // Plan which live images to send and record the authoritative inventory.
  // Carousels legitimately carry many assets (cards × per-placement sizes); the
  // Drive side caps carousels at 10, so the live cap MUST match or exceed it. A
  // lower live cap silently drops live cards and makes the model report them
  // "missing" — the asymmetric-cap false positive. Single-image ads keep the
  // small cap (their pool is one creative plus size/stale variants). planQaImages
  // also round-robins the carousel pool across sizes so any future truncation
  // degrades gracefully instead of dropping one whole size.
  const MAX_QA_IMAGES = isCarousel ? 12 : 6;
  const { ordered: plannedCandidates, inventory } = planQaImages(
    chosenImageCandidates,
    isCarousel,
    cardDimensions.length,
    MAX_QA_IMAGES
  );
  chosenImageCandidates = plannedCandidates;
  formatInfo.creativeInventory = inventory;

  // Build the final URL list from the chosen pool images, then video thumbnails.
  const seenUrls = new Set<string>();
  const creativeImageUrls: string[] = [];
  function addUrl(u: string | undefined | null) {
    if (u && !seenUrls.has(u) && creativeImageUrls.length < MAX_QA_IMAGES) {
      seenUrls.add(u);
      creativeImageUrls.push(u);
    }
  }
  for (const c of chosenImageCandidates) addUrl(c.url);
  const videoThumbUrls = new Set<string>();
  for (const vid of data.creative?.asset_feed_spec?.videos ?? []) {
    if (vid.thumbnail_url) videoThumbUrls.add(vid.thumbnail_url);
    addUrl(vid.thumbnail_url);
  }
  // Single-video ads using object_story_spec.video_data don't have a thumbnail_url
  // in the creative JSON — they only have a video_id. The fetchVideoDimensions call
  // above now also fetches `picture` (Meta's auto-selected thumbnail frame) so we
  // can add it here. Without this, these ads produce zero creativeImageUrls and the
  // QA model incorrectly reports "no live image returned by the Meta API."
  if (singleVideoId) {
    const vidIdx = allVideoIds.indexOf(singleVideoId);
    const vidMeta = vidIdx >= 0 ? videoDims[vidIdx] : null;
    const thumb = vidMeta?.thumbnailUrl;
    if (thumb && !seenUrls.has(thumb)) {
      videoThumbUrls.add(thumb);
      addUrl(thumb);
    }
  }

  // --- Per-image placement + date context ---------------------------------
  // Tag each chosen image with the placement(s) it serves and the date its
  // asset was created, and flag any asset much older than the newest one in
  // this ad as a likely previous-promo leftover. This is what lets the QA model
  // say "the Story placement uses a Feb-dated asset" instead of silently
  // surfacing old creative as a phantom.
  const creativeImageContext: CreativeImageContext[] = [];
  {
    const hashContext = buildHashContext(data.creative?.asset_feed_spec);
    const urlToHash = new Map<string, string>();
    for (const c of feedImageCandidates) if (c.hash) urlToHash.set(c.url, c.hash);

    // Newest asset date in this ad — the reference point for "stale".
    let newestMs = -Infinity;
    for (const { dateMs } of Array.from(hashContext.values())) {
      if (dateMs && dateMs > newestMs) newestMs = dateMs;
    }
    const gapMs = STALE_ASSET_AGE_GAP_DAYS * 24 * 60 * 60 * 1000;

    for (const url of creativeImageUrls) {
      const hash = urlToHash.get(url);
      const entry = hash ? hashContext.get(hash) : undefined;
      const placement = entry && entry.placements.length ? entry.placements.join(" | ") : null;
      const assetDate =
        entry?.dateMs != null ? new Date(entry.dateMs).toISOString().slice(0, 10) : null;
      let staleNote: string | null = null;
      if (entry?.dateMs != null && Number.isFinite(newestMs) && newestMs - entry.dateMs > gapMs) {
        const daysOlder = Math.round((newestMs - entry.dateMs) / (24 * 60 * 60 * 1000));
        staleNote = `This asset is ~${daysOlder} days older than the newest asset in this ad — likely a leftover from a previous promo cycle. Verify it should still be here.`;
      }
      creativeImageContext.push({ url, placement, assetDate, staleNote });
    }
  }

  // Tag video thumbnails: a thumbnail is ONE auto-selected frame of the video,
  // not the creative itself. Without this
  // label the QA model treats the frame as a static and flags text present in
  // other parts of the video as "missing" (or vice versa) — phantom mismatches.
  for (const url of creativeImageUrls) {
    if (!videoThumbUrls.has(url)) continue;
    const existing = creativeImageContext.find((c) => c.url === url);
    if (existing) existing.videoThumbnail = true;
    else creativeImageContext.push({ url, placement: null, assetDate: null, staleNote: null, videoThumbnail: true });
  }

  // Diagnostic: shows how the image pool was reduced, with sizes — confirms in
  // production whether the extra images were stale same-size dupes or legit
  // per-placement size variants. Remove once dedup behaviour is confirmed.
  const optType = data.creative?.asset_feed_spec?.optimization_type ?? "n/a";
  const poolSizes = feedImageCandidates
    .map((c) => (c.width && c.height ? `${c.width}x${c.height}` : "??"))
    .join(",");
  dbg(
    `[meta-api][img] ad=${adId} name="${data.name ?? ""}" carousel=${isCarousel} ` +
      `optimization_type=${optType} pool=${feedImageCandidates.length} [${poolSizes}] ` +
      `published_hash=${publishedHash ? "yes" : "no"} live_source=${liveSource} ` +
      `cap=${MAX_QA_IMAGES} → chosen=${creativeImageUrls.length}` +
      `${formatInfo.creativeInventory?.truncated ? " TRUNCATED" : ""}`
  );

  // Per-ad manual-check list. Confirmed enhancement toggles MISSING from
  // degrees_of_freedom_spec were not reported by the API for this ad — since
  // Meta defaults several of them to ON, "all API-readable enhancements are
  // off" would overstate. List the unreported ones for manual verification.
  // Only applies when the spec exists but is partial; a fully absent spec is
  // already covered by the "enhancement data unavailable" note.
  let manualCheckItems = MANUAL_CHECK_ITEMS;
  const featureSpec = data.creative?.degrees_of_freedom_spec?.creative_features_spec;
  if (featureSpec) {
    const absent = CONFIRMED_ENHANCEMENT_KEYS.filter((k) => !(k in featureSpec));
    if (absent.length) {
      manualCheckItems = [
        ...MANUAL_CHECK_ITEMS,
        ...absent.map(
          (k) => `${ENHANCEMENT_LABELS[k] ?? k} (not reported by the API for this ad — Meta may default it ON)`
        ),
      ];
    }
  }

  return {
    content: formatted,
    error: formatted ? null : "Meta returned the ad but no readable creative fields were present.",
    aiEnhancements,
    formatInfo,
    creativeImageUrls,
    creativeImageContext,
    manualCheckItems,
  };
}

/**
 * Parses degrees_of_freedom_spec into a flat list of AI enhancement toggles.
 * Returns null if the field is absent (older ad / not retrieved).
 */
function parseAiEnhancements(spec?: DegreesOfFreedomSpec): AiEnhancement[] | null {
  if (!spec?.creative_features_spec) return null;
  const features = spec.creative_features_spec;
const results: AiEnhancement[] = [];
  for (const [key, entry] of Object.entries(features)) {
    if (!entry) continue;
    if (UNRELIABLE_API_KEYS.has(key)) continue;
    const label = ENHANCEMENT_LABELS[key] ?? key.replace(/_/g, " ");
    results.push({
      key,
      label,
      status: entry.enroll_status === "OPT_IN" ? "on" : "off",
    });
  }
  return results.length > 0 ? results : null;
}

function formatCreative(data: AdResponse): string | null {
  const lines: string[] = [];
  const c = data.creative ?? {};

  if (data.name) lines.push(`Ad name: ${data.name}`);
  if (c.name && c.name !== data.name) lines.push(`Creative name: ${c.name}`);

  // Top-level creative fields (older ad types)
  if (c.title) lines.push(`Headline: ${c.title}`);
  if (c.body) lines.push(`Body copy: ${c.body}`);
  if (c.call_to_action_type) lines.push(`CTA type: ${c.call_to_action_type}`);
  if (c.link_url) lines.push(`Destination URL: ${c.link_url}`);

  // object_story_spec — link/carousel/video ads
  const spec = c.object_story_spec;
  if (spec?.link_data) {
    const ld = spec.link_data;
    if (ld.message) lines.push(`Post copy: ${ld.message}`);
    if (ld.name) lines.push(`Link headline: ${ld.name}`);
    if (ld.description) lines.push(`Link description: ${ld.description}`);
    if (ld.link) lines.push(`Link URL: ${ld.link}`);
    if (ld.caption) lines.push(`Caption: ${ld.caption}`);
    if (ld.call_to_action?.type) lines.push(`CTA: ${ld.call_to_action.type}`);
    if (ld.call_to_action?.value?.link)
      lines.push(`CTA URL: ${ld.call_to_action.value.link}`);

    // Carousel cards
    if (ld.child_attachments?.length) {
      lines.push(`\nCarousel cards (${ld.child_attachments.length}):`);
      ld.child_attachments.forEach((card, i) => {
        const cardLines: string[] = [];
        if (card.name) cardLines.push(`headline: ${card.name}`);
        if (card.description) cardLines.push(`desc: ${card.description}`);
        if (card.link) cardLines.push(`url: ${card.link}`);
        if (card.call_to_action?.type)
          cardLines.push(`cta: ${card.call_to_action.type}`);
        lines.push(`  Card ${i + 1}: ${cardLines.join(" | ")}`);
      });
    }
  }

  if (spec?.video_data) {
    const vd = spec.video_data;
    if (vd.message) lines.push(`Video copy: ${vd.message}`);
    if (vd.title) lines.push(`Video title: ${vd.title}`);
    if (vd.call_to_action?.type) lines.push(`CTA: ${vd.call_to_action.type}`);
    if (vd.call_to_action?.value?.link)
      lines.push(`CTA URL: ${vd.call_to_action.value.link}`);
  }

  // asset_feed_spec — dynamic/flexible ads
  const feed = c.asset_feed_spec;
  if (feed) {
    if (feed.bodies?.length) {
      lines.push(`\nAd bodies:`);
      feed.bodies.forEach((b, i) => b.text && lines.push(`  ${i + 1}. ${b.text}`));
    }
    if (feed.titles?.length) {
      // Apply the same date-filtering as images: titles accumulate stale entries
      // from previous promo cycles in the asset_feed_spec pool. If any title has
      // a timestamp adlabel, drop titles that are much older than the newest one.
      const titlesWithDates = feed.titles.map((t) => {
        let dateMs: number | null = null;
        for (const l of t.adlabels ?? []) {
          dateMs = dateMs ?? assetLabelDateMs(l.name);
        }
        return { text: t.text, dateMs };
      });
      const newestTitleMs = titlesWithDates.reduce(
        (max, t) => (t.dateMs != null && t.dateMs > max ? t.dateMs : max),
        -Infinity
      );
      const gapMs = STALE_ASSET_AGE_GAP_DAYS * 24 * 60 * 60 * 1000;
      const freshTitles = titlesWithDates.filter(
        (t) =>
          newestTitleMs === -Infinity || // no dates at all — keep all
          t.dateMs == null ||            // this title has no date — keep (can't tell)
          newestTitleMs - t.dateMs <= gapMs // within the freshness window
      );
      const staleTitles = titlesWithDates.filter(
        (t) =>
          newestTitleMs !== -Infinity &&
          t.dateMs != null &&
          newestTitleMs - t.dateMs > gapMs
      );
      lines.push(`Ad titles:`);
      freshTitles.forEach((t, i) => t.text && lines.push(`  ${i + 1}. ${t.text}`));
      if (staleTitles.length) {
        lines.push(
          `  [⚠️ ATTENTION: ${staleTitles.length} title(s) omitted above — dated ${STALE_ASSET_AGE_GAP_DAYS}+ days before the newest asset, likely stale from a prior promo: ${staleTitles.map((t) => `"${t.text}"`).join(", ")}. If this ad is paused or was edited without relaunching, a stale title may still be what is actually serving — mention this in the promo/date check note so it gets verified in Ads Manager.]`
        );
      }
    }
    if (feed.descriptions?.length) {
      lines.push(`Ad descriptions:`);
      feed.descriptions.forEach((d, i) => d.text && lines.push(`  ${i + 1}. ${d.text}`));
    }
    if (feed.call_to_action_types?.length) {
      lines.push(`CTA types: ${feed.call_to_action_types.join(", ")}`);
    }
    if (feed.link_urls?.length) {
      lines.push(`Landing URLs:`);
      feed.link_urls.forEach(
        (l, i) => l.website_url && lines.push(`  ${i + 1}. ${l.website_url}`)
      );
    }
  }

  return lines.join("\n").trim() || null;
}
