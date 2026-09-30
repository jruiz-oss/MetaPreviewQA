/**
 * Regression test for FIX #30 / #31 (Round 8) — fetchAdContent end to end with
 * a stubbed Graph API.
 *
 *  1. Stale pool images skipped by the customization-rules filter must NOT be
 *     re-added by the configured-hash loop (they used to be).
 *  2. Carousel VIDEO cards (child_attachments.video_id) are excluded from the
 *     image-only dims and tagged as video thumbnails; an unresolvable card
 *     falls back to its `picture` URL.
 *  3. AdImages lookups follow pagination.
 *
 * Run: npx tsx lib/__tests__/meta-pool-and-cards.test.ts
 */
import { fetchAdContent } from "@/lib/meta-api";

let failures = 0;
function assert(cond: boolean, msg: string) {
  if (cond) console.log(`  ✓ ${msg}`);
  else { console.log(`  ✗ ${msg}`); failures++; }
}

type Img = { hash: string; width: number; height: number; url: string };
function stubGraph(ad: unknown, images: Img[], pageSize = 100) {
  const calls: string[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const u = String(input);
    calls.push(u);
    const json = (b: unknown) => new Response(JSON.stringify(b), { headers: { "content-type": "application/json" } });
    if (u.includes("/adimages")) {
      const after = Number(new URL(u).searchParams.get("after") ?? "0");
      const slice = images.slice(after, after + pageSize);
      const next = after + pageSize < images.length ? `${u.split("&after=")[0]}&after=${after + pageSize}` : undefined;
      return json({ data: slice, paging: next ? { next } : {} });
    }
    if (u.includes("fields=targeting")) return json({ targeting: {} });
    if (u.includes("audios")) return json({ creative: {} });
    return json(ad);
  }) as typeof fetch;
  return calls;
}

(async () => {
  console.log("Scenario 1: rules filter active, stale unique-size pool image stays out");
  {
    const images: Img[] = [
      { hash: "live1", width: 1080, height: 1080, url: "https://cdn/live1" },
      { hash: "live2", width: 1080, height: 1920, url: "https://cdn/live2" },
      { hash: "stale", width: 1200, height: 628, url: "https://cdn/stale" },
    ];
    stubGraph({
      id: "1", name: "September Static V1", adset_id: "9", account_id: "5",
      creative: {
        asset_feed_spec: {
          images: [
            { hash: "live1", adlabels: [{ name: "lab_a_1756684800000" }] },
            { hash: "live2", adlabels: [{ name: "lab_b_1756684800000" }] },
            { hash: "stale", adlabels: [{ name: "lab_old_1748736000000" }] },
          ],
          asset_customization_rules: [
            { image_label: { name: "lab_a_1756684800000" }, customization_spec: {} },
            { image_label: { name: "lab_b_1756684800000" }, customization_spec: {} },
          ],
        },
      },
    }, images);
    const r = await fetchAdContent("1", "tok");
    assert(!r.creativeImageUrls.includes("https://cdn/stale"), "stale pool image not sent to visual QA");
    assert(r.creativeImageUrls.length === 2, `2 live images sent (got ${r.creativeImageUrls.length})`);
    const sizes = (r.formatInfo?.creativeInventory?.sizes ?? []).map((s) => s.size);
    assert(!sizes.includes("1200x628"), "stale size not in live inventory");
  }

  console.log("\nScenario 2: carousel with a video card + an unresolvable card");
  {
    const images: Img[] = [
      { hash: "c1", width: 1080, height: 1080, url: "https://cdn/c1" },
      { hash: "c2", width: 1080, height: 1080, url: "https://cdn/c2" },
      { hash: "vcover", width: 1280, height: 720, url: "https://cdn/vcover" },
    ];
    stubGraph({
      id: "2", name: "September Carousel 1", adset_id: "9", account_id: "5",
      creative: {
        object_story_spec: {
          link_data: {
            child_attachments: [
              { image_hash: "c1" },
              { image_hash: "c2" },
              { image_hash: "vcover", video_id: "v9" },
              { image_hash: "gone", picture: "https://cdn/picture-gone" },
            ],
          },
        },
      },
    }, images);
    const r = await fetchAdContent("2", "tok");
    const fi = r.formatInfo!;
    assert(fi.cardDimensions?.length === 2, `video card excluded from card uniformity dims (got ${fi.cardDimensions?.length})`);
    assert(!(fi.imageDimensions ?? []).some((d) => d.width === 1280), "video cover frame not in image-only dims");
    assert(r.creativeImageUrls.includes("https://cdn/picture-gone"), "unresolvable card falls back to its picture URL");
    const vc = r.creativeImageContext.find((c) => c.url === "https://cdn/vcover");
    assert(!!vc?.videoThumbnail, "video card cover tagged as VIDEO THUMBNAIL");
  }

  console.log("\nScenario 3: AdImages pagination");
  {
    const images: Img[] = Array.from({ length: 30 }, (_, i) => ({
      hash: `h${i}`, width: 1080, height: i < 15 ? 1080 : 1920, url: `https://cdn/h${i}`,
    }));
    const calls = stubGraph({
      id: "3", name: "September Carousel 2", adset_id: "9", account_id: "5",
      creative: { object_story_spec: { link_data: { child_attachments: images.slice(0, 10).map((i) => ({ image_hash: i.hash })).concat([{ image_hash: "h29" }]) } } },
    }, images, 25);
    const r = await fetchAdContent("3", "tok");
    assert(calls.filter((c) => c.includes("/adimages")).length === 2, "followed the adimages cursor to page 2");
    assert(r.creativeImageUrls.includes("https://cdn/h29"), "card resolved from page 2 reaches visual QA");
  }

  console.log(failures ? `\n${failures} assertion(s) FAILED` : "\nAll assertions passed.");
  process.exit(failures ? 1 : 0);
})();
