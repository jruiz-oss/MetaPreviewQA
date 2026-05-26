const GRAPH_API = "https://graph.facebook.com/v23.0";

export type CampaignAd = {
  id: string;
  name: string;
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

export type FormatInfo = {
  placements: PlacementInfo | null;
  imageDimensions: ImageDimensions | null;
};

/**
 * Fetches all ads under a campaign ID from the Meta Graph API.
 * Returns up to 200 ads (paginates once if needed).
 */
export async function fetchCampaignAdsList(
  campaignId: string,
  accessToken: string
): Promise<{ ads: CampaignAd[]; error: string | null }> {
  const url = `${GRAPH_API}/${campaignId}/ads?fields=id,name&limit=200&access_token=${accessToken}`;

  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(10000) });
    const data = await res.json();

    if (data.error) {
      const code = data.error.code;
      const msg = data.error.message ?? "Unknown Meta API error";
      let friendly = `Meta API error (code ${code}): ${msg}`;
      if (code === 190) friendly = `Access token invalid or expired. Regenerate META_ACCESS_TOKEN.`;
      else if (code === 100) friendly = `Invalid campaign ID or bad request. Check the ID and try again.`;
      else if (code === 200) friendly = `Token missing required permissions (needs ads_read or ads_management).`;
      return { ads: [], error: friendly };
    }

    const ads: CampaignAd[] = (data.data ?? []).map((ad: { id: string; name: string }) => ({
      id: ad.id,
      name: ad.name,
    }));

    return { ads, error: null };
  } catch (err) {
    return { ads: [], error: `Network error: ${(err as Error).message}` };
  }
}

/**
 * Resolves a Meta preview URL to an ad/creative ID.
 * Handles:
 *   - Numeric IDs pasted directly: 120210001234567
 *   - Ads Manager URLs with ?id= param: facebook.com/ads/preview/?id=XXXXX
 *   - fb.me short links: fb.me/adspreview/facebook/1Z3drgvvv0VRnUA  (follows redirect)
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
    if (fromParams) return fromParams.split(",")[0].trim();

    return null;
  } catch {
    return null;
  }
}

async function followRedirect(url: string): Promise<string | null> {
  try {
    const res = await fetch(url, {
      redirect: "follow",
      signal: AbortSignal.timeout(8000),
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
      },
    });
    // res.url is the final URL after all redirects
    return res.url !== url ? res.url : null;
  } catch {
    return null;
  }
}

type EnrollStatus = "OPT_IN" | "OPT_OUT" | string;
type CreativeFeatureEntry = { enroll_status?: EnrollStatus };

type DegreesOfFreedomSpec = {
  creative_features_spec?: {
    standard_enhancements?: CreativeFeatureEntry;
    image_brightness_and_contrast?: CreativeFeatureEntry;
    image_templates?: CreativeFeatureEntry;
    image_uncrop?: CreativeFeatureEntry;
    relevant_comments?: CreativeFeatureEntry;
    music?: CreativeFeatureEntry;
    inline_comment?: CreativeFeatureEntry;
    visual_touch_up?: CreativeFeatureEntry;
    body_label?: CreativeFeatureEntry;
    title_label?: CreativeFeatureEntry;
    description_label?: CreativeFeatureEntry;
    [key: string]: CreativeFeatureEntry | undefined;
  };
};

export type AiEnhancement = {
  key: string;
  label: string;
  status: "on" | "off";
};

const ENHANCEMENT_LABELS: Record<string, string> = {
  standard_enhancements: "All standard enhancements",
  image_brightness_and_contrast: "Image brightness & contrast",
  image_templates: "Image templates",
  image_uncrop: "Image expansion (uncrop)",
  relevant_comments: "Relevant comments",
  music: "Music",
  inline_comment: "Inline comments",
  visual_touch_up: "Visual touch-up",
  body_label: "Body text label",
  title_label: "Title label",
  description_label: "Description label",
};

type CreativeFields = {
  id?: string;
  name?: string;
  body?: string;
  title?: string;
  call_to_action_type?: string;
  link_url?: string;
  image_hash?: string;
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
    titles?: Array<{ text?: string }>;
    call_to_action_types?: string[];
    link_urls?: Array<{ website_url?: string }>;
  };
};

type AdResponse = {
  id?: string;
  name?: string;
  adset_id?: string;
  account_id?: string;
  creative?: CreativeFields;
  error?: { message?: string; code?: number };
};

export type FetchResult = {
  content: string | null;
  error: string | null;
  aiEnhancements: AiEnhancement[] | null;
  formatInfo: FormatInfo | null;
};

/**
 * Fetches ad creative content from the Meta Graph API.
 * Returns the formatted content, or a human-readable error string if Meta rejected the call.
 */
/**
 * Fetches placement targeting from an ad set.
 */
async function fetchAdsetPlacements(adsetId: string, accessToken: string): Promise<PlacementInfo | null> {
  try {
    const url = `${GRAPH_API}/${adsetId}?fields=targeting&access_token=${accessToken}`;
    const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
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

/**
 * Fetches image dimensions from the AdImages endpoint using an image hash.
 */
async function fetchImageDimensions(accountId: string, imageHash: string, accessToken: string): Promise<ImageDimensions | null> {
  try {
    const hashParam = encodeURIComponent(JSON.stringify([imageHash]));
    const url = `${GRAPH_API}/act_${accountId}/adimages?hashes=${hashParam}&fields=width,height,hash&access_token=${accessToken}`;
    const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
    const data = await res.json();
    if (data.error || !data.data?.length) return null;
    const img = data.data[0];
    if (!img.width || !img.height) return null;
    return { width: img.width, height: img.height };
  } catch {
    return null;
  }
}

/**
 * Fetches video dimensions from the Video object using a video ID.
 * Uses the "format" field which returns an array of renditions — we pick the largest (original).
 */
async function fetchVideoDimensions(videoId: string, accessToken: string): Promise<ImageDimensions | null> {
  try {
    const url = `${GRAPH_API}/${videoId}?fields=format&access_token=${accessToken}`;
    const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
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
    return { width: original.width, height: original.height };
  } catch {
    return null;
  }
}

export async function fetchAdContent(
  adId: string,
  accessToken: string
): Promise<FetchResult> {
  const fields = [
    "adset_id",
    "account_id",
    "name",
    "creative{body,title,call_to_action_type,link_url,name,image_hash,object_story_spec{link_data{message,name,description,link,caption,image_hash,call_to_action,child_attachments},video_data{message,title,video_id,call_to_action}},asset_feed_spec,degrees_of_freedom_spec}",
  ].join(",");

  const url = `${GRAPH_API}/${adId}?fields=${encodeURIComponent(fields)}&access_token=${accessToken}`;

  let data: AdResponse;
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(10000) });
    data = await res.json();
  } catch (err) {
    return { content: null, error: `Network error contacting Meta API: ${(err as Error).message}`, aiEnhancements: null, formatInfo: null };
  }

  if (data.error) {
    console.error(`Meta API error for ad ${adId}:`, data.error);
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
      friendly = `Bad request — likely an unknown field or malformed ID. Original: ${msg}`;
    } else if (code === 200) {
      friendly = `Token is missing required permissions (need ads_read or ads_management). Original: ${msg}`;
    }

    return { content: null, error: friendly, aiEnhancements: null, formatInfo: null };
  }

  const formatted = formatCreative(data);
  const aiEnhancements = parseAiEnhancements(data.creative?.degrees_of_freedom_spec);

  console.log("[dim-debug] creative keys:", JSON.stringify(Object.keys(data.creative ?? {})));
  console.log("[dim-debug] object_story_spec:", JSON.stringify(data.creative?.object_story_spec ?? null));
  console.log("[dim-debug] asset_feed_spec keys:", JSON.stringify(Object.keys(data.creative?.asset_feed_spec ?? {})));

  // Fetch placement and creative dimension data in parallel
  const adsetId = data.adset_id;
  const accountId = data.account_id;

  // Image hash: check top-level creative field first, then link_data
  const imageHash =
    data.creative?.image_hash ??
    data.creative?.object_story_spec?.link_data?.image_hash;

  // Video ID: lives inside object_story_spec.video_data
  const videoId = data.creative?.object_story_spec?.video_data?.video_id;

  const [placements, imageDimensions] = await Promise.all([
    adsetId ? fetchAdsetPlacements(adsetId, accessToken) : Promise.resolve(null),
    accountId && imageHash
      ? fetchImageDimensions(accountId, imageHash, accessToken)
      : videoId
      ? fetchVideoDimensions(videoId, accessToken)
      : Promise.resolve(null),
  ]);

  const formatInfo: FormatInfo = { placements, imageDimensions };

  return {
    content: formatted,
    error: formatted ? null : "Meta returned the ad but no readable creative fields were present.",
    aiEnhancements,
    formatInfo,
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
      lines.push(`Ad titles:`);
      feed.titles.forEach(
        (t, i) => t.text && lines.push(`  ${i + 1}. ${t.text}`)
      );
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
