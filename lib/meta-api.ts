const GRAPH_API = "https://graph.facebook.com/v19.0";

/**
 * Extracts an ad ID from a Meta preview URL or returns the raw value if it's already a numeric ID.
 * Handles formats like:
 *   https://www.facebook.com/ads/preview/?id=120210001234567
 *   https://business.facebook.com/ads/preview/?id=120210001234567&creative_id=...
 *   https://www.facebook.com/ads/api/preview/?id=120210001234567
 *   120210001234567  (raw ID pasted directly)
 */
export function extractAdId(input: string): string | null {
  const trimmed = input.trim();

  // Already a numeric ID
  if (/^\d+$/.test(trimmed)) return trimmed;

  try {
    const url = new URL(trimmed.startsWith("http") ? trimmed : `https://${trimmed}`);
    return (
      url.searchParams.get("id") ||
      url.searchParams.get("ad_id") ||
      url.searchParams.get("creative_id") ||
      null
    );
  } catch {
    return null;
  }
}

type CreativeFields = {
  id?: string;
  name?: string;
  body?: string;
  title?: string;
  call_to_action_type?: string;
  link_url?: string;
  object_story_spec?: {
    link_data?: {
      message?: string;
      name?: string;
      description?: string;
      link?: string;
      caption?: string;
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
  creative?: CreativeFields;
  error?: { message?: string; code?: number };
};

/**
 * Fetches ad creative content from the Meta Graph API.
 * Returns a plain-text summary of the ad copy, headline, CTA, and URL
 * suitable for Claude to review against a work order.
 */
export async function fetchAdContent(
  adId: string,
  accessToken: string
): Promise<string | null> {
  const fields = [
    "name",
    "creative{body,title,call_to_action_type,link_url,name,object_story_spec,asset_feed_spec}",
  ].join(",");

  const url = `${GRAPH_API}/${adId}?fields=${encodeURIComponent(fields)}&access_token=${accessToken}`;

  let data: AdResponse;
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(10000) });
    data = await res.json();
  } catch {
    return null;
  }

  if (data.error) {
    console.error(`Meta API error for ad ${adId}:`, data.error);
    return null;
  }

  return formatCreative(data);
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
    if (ld.call_to_action?.value?.link) lines.push(`CTA URL: ${ld.call_to_action.value.link}`);

    // Carousel cards
    if (ld.child_attachments?.length) {
      lines.push(`\nCarousel cards (${ld.child_attachments.length}):`);
      ld.child_attachments.forEach((card, i) => {
        const cardLines: string[] = [];
        if (card.name) cardLines.push(`headline: ${card.name}`);
        if (card.description) cardLines.push(`desc: ${card.description}`);
        if (card.link) cardLines.push(`url: ${card.link}`);
        if (card.call_to_action?.type) cardLines.push(`cta: ${card.call_to_action.type}`);
        lines.push(`  Card ${i + 1}: ${cardLines.join(" | ")}`);
      });
    }
  }

  if (spec?.video_data) {
    const vd = spec.video_data;
    if (vd.message) lines.push(`Video copy: ${vd.message}`);
    if (vd.title) lines.push(`Video title: ${vd.title}`);
    if (vd.call_to_action?.type) lines.push(`CTA: ${vd.call_to_action.type}`);
    if (vd.call_to_action?.value?.link) lines.push(`CTA URL: ${vd.call_to_action.value.link}`);
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
      feed.titles.forEach((t, i) => t.text && lines.push(`  ${i + 1}. ${t.text}`));
    }
    if (feed.call_to_action_types?.length) {
      lines.push(`CTA types: ${feed.call_to_action_types.join(", ")}`);
    }
    if (feed.link_urls?.length) {
      lines.push(`Landing URLs:`);
      feed.link_urls.forEach((l, i) => l.website_url && lines.push(`  ${i + 1}. ${l.website_url}`));
    }
  }

  return lines.join("\n").trim() || null;
}
