/**
 * Regression test for FIX #35: creative-not-swapped check against the
 * previous-cycle ad each duplicate came from (source_ad_id chain).
 * Run: npx tsx lib/__tests__/creative-swap.test.ts
 */
import { checkCreativeSwap, isPriorCycle, creativeUnswapped } from "@/lib/meta-api";
import { monthsInStructuredName as m } from "@/lib/month-match";

let failures = 0;
function assert(cond: boolean, msg: string) {
  if (cond) console.log(`  ✓ ${msg}`);
  else { console.log(`  ✗ ${msg}`); failures++; }
}

type Ad = { name: string; adset: string; created: string; source?: string; hashes: string[] };
function stub(ads: Record<string, Ad>) {
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const id = String(input).split("/v23.0/")[1].split("?")[0];
    const a = ads[id];
    const body = a
      ? { name: a.name, created_time: a.created, source_ad_id: a.source, adset: { name: a.adset }, creative: { asset_feed_spec: { images: a.hashes.map((hash) => ({ hash })) } } }
      : { error: { code: 100 } };
    return new Response(JSON.stringify(body));
  }) as typeof fetch;
}

(async () => {
  console.log("Pure helpers");
  assert(isPriorCycle({ name: "August Static V1", adsetName: "September Retargeting", createdTime: "" }, { name: "August Static V1", adsetName: "August Retargeting", createdTime: "" }, m) === true, "ad set month decides even when the ad name wasn't renamed");
  assert(isPriorCycle({ name: "S V1", adsetName: "September Lookalike", createdTime: "" }, { name: "S V1", adsetName: "September Interest", createdTime: "" }, m) === false, "same-month sibling is same cycle");
  assert(isPriorCycle({ name: "Static V1", adsetName: "Retargeting", createdTime: "2026-09-20T00:00:00Z" }, { name: "Static V1", adsetName: "Retargeting", createdTime: "2026-06-01T00:00:00Z" }, m) === true, "no months: 3-month created gap = prior cycle");
  assert(creativeUnswapped(["a", "b"], ["a", "b", "c"]) === true, "subset of source = unswapped");
  assert(creativeUnswapped(["a", "new"], ["a", "b"]) === false, "one new asset = swapped");

  console.log("\nChain walk");
  stub({
    aug: { name: "August Static V1", adset: "August Interest", created: "2026-08-01T00:00:00Z", hashes: ["old1", "old2"] },
    sepInt: { name: "September Static V1", adset: "September Interest", created: "2026-09-20T00:00:00Z", source: "aug", hashes: ["new1", "new2"] },
    sepLal: { name: "September Static V1", adset: "September Lookalike", created: "2026-09-21T00:00:00Z", source: "sepInt", hashes: ["new1", "new2"] },
    sepRet: { name: "September Static V1", adset: "September Retargeting", created: "2026-09-20T00:00:00Z", source: "aug", hashes: ["old1", "old2"] },
    fresh: { name: "September Static V3", adset: "September Interest", created: "2026-09-20T00:00:00Z", hashes: ["x"] },
  });
  const lal = await checkCreativeSwap("sepLal", ["new1", "new2"], "t", m);
  assert(lal?.unswapped === false && lal.sourceAdId === "aug", "same-cycle copy of a swapped ad: walks past sibling, not flagged");
  const ret = await checkCreativeSwap("sepRet", ["old1", "old2"], "t", m);
  assert(ret?.unswapped === true && ret.sourceName === "August Static V1", "duplicate still carrying August hashes: flagged");
  assert((await checkCreativeSwap("fresh", ["x"], "t", m)) === null, "ad built from scratch: no verdict");
  stub({ sepRet: { name: "S", adset: "September Retargeting", created: "", source: "missing", hashes: ["old1"] } });
  assert((await checkCreativeSwap("sepRet", ["old1"], "t", m)) === null, "unreadable source: couldn't verify, no finding");

  console.log(failures ? `\n${failures} assertion(s) FAILED` : "\nAll assertions passed.");
  process.exit(failures ? 1 : 0);
})();
