// Run: npx tsx lib/__tests__/image-similarity.test.ts
import assert from "node:assert/strict";
import sharp from "sharp";
import { fingerprint, hamming, aspectKey, analyzeCardCoverage, applyCoverage, nameLiveImages, driveDisplayName, type FP } from "../image-similarity";

// Deterministic "design": coarse colored blocks so each seed is a clearly different card.
async function card(seed: number, size = 1080): Promise<Buffer> {
  let s = seed * 9301 + 49297;
  const rnd = () => ((s = (s * 9301 + 49297) % 233280) / 233280);
  const cells = 8;
  const raw = Buffer.alloc(cells * cells * 3);
  for (let i = 0; i < raw.length; i++) raw[i] = Math.floor(rnd() * 256);
  return sharp(raw, { raw: { width: cells, height: cells, channels: 3 } })
    .resize(size, size, { kernel: "nearest" })
    .jpeg({ quality: 90 })
    .toBuffer();
}
// The Altura edit: same card, one small text-sized region changed, re-encoded at another size.
async function edited(seed: number, size = 1254): Promise<Buffer> {
  const base = await card(seed, 1080);
  const patch = await sharp({ create: { width: 220, height: 40, channels: 3, background: { r: 255, g: 255, b: 255 } } }).png().toBuffer();
  return sharp(base).composite([{ input: patch, left: 300, top: 620 }]).resize(size, size).jpeg({ quality: 70 }).toBuffer();
}
const fp = async (b: Buffer, label: string): Promise<FP> => (await fingerprint(b.toString("base64"), label))!;

(async () => {
  assert.equal(aspectKey(1), "1:1");
  assert.equal(aspectKey(1254 / 1254), "1:1");
  assert.equal(aspectKey(1080 / 1920), "9:16");

  const approved = [1, 2, 3, 4].map(() => null as unknown as FP);
  for (let i = 0; i < 4; i++) approved[i] = await fp(await card(i + 1), `Card ${i + 1}`);

  // Fingerprints survive re-encode + resize + a small text edit, and separate distinct cards.
  const c2 = approved[1];
  const c2edit = await fp(await edited(2), "edited card 2");
  assert.ok(hamming(c2.bits, c2edit.bits) <= 20, `edited card should stay close, got ${hamming(c2.bits, c2edit.bits)}`);
  assert.ok(hamming(approved[0].bits, approved[1].bits) > 60, "distinct cards should be far apart");

  // THE ALTURA CASE: live 1:1 set = card1, card2, edited card2, card3 (card 4 absent, card 2 twice).
  {
    const live = [await fp(await card(1, 1080), "live 1"), await fp(await card(2, 1080), "live 2"), c2edit, await fp(await card(3, 1080), "live 3")];
    const r = analyzeCardCoverage(live, approved);
    assert.equal(r.severity, "fail");
    assert.ok(r.notes.some((n) => /appears twice/.test(n) && /only 3/.test(n) && !/\.(jpg|png)/.test(n)), r.notes.join(" | "));
    assert.ok(r.notes.some((n) => /Card 4/.test(n)), "missing approved card 4 is named");
    const merged = applyCoverage({ status: "pass", note: "Matches." }, r)!;
    assert.equal(merged.status, "fail");
    assert.doesNotMatch(String(merged.note), /Matches/);
  }

  // Healthy carousel: 4 distinct live cards (one edited copy is fine) -> no finding.
  {
    const live = [await fp(await card(1), "l1"), c2edit, await fp(await card(3), "l3"), await fp(await card(4, 1254), "l4")];
    const r = analyzeCardCoverage(live, approved);
    assert.equal(r.severity, null, r.notes.join(" | "));
    assert.equal(applyCoverage({ status: "pass", note: "ok" }, r)!.status, "pass");
  }

  // Templated approved cards that are nearly identical -> group skipped, never a false duplicate.
  {
    const base = await card(7);
    const near = await Promise.all([0, 1, 2, 3].map(async (i) => {
      const patch = await sharp({ create: { width: 120 + i * 10, height: 30, channels: 3, background: { r: 0, g: 0, b: 0 } } }).png().toBuffer();
      return fp(await sharp(base).composite([{ input: patch, left: 100 * i, top: 500 }]).jpeg().toBuffer(), `T${i + 1}`);
    }));
    const r = analyzeCardCoverage(near, near);
    assert.equal(r.severity, null);
  }

  // Different aspect sets are never compared with each other; unreadable input is ignored.
  assert.equal(analyzeCardCoverage([], approved).severity, null);
  assert.equal(await fingerprint("bm90IGFuIGltYWdl", "junk"), null);
  // Round 8b: live images get the approved Drive name, not the CDN file name.
  {
    assert.equal(driveDisplayName("Carousel/1080x1080/Altura-00023 - Meta - 2026 - Carousel 1080x1080 - 2.jpg"), "Altura-00023 - Meta - 2026 - Carousel 1080x1080 - 2");
    assert.equal(driveDisplayName("Video/Promo Video 1080x1920.mp4 (Drive thumbnail frame)"), "Promo Video 1080x1920");
    const b64 = async (b: Promise<Buffer>) => (await b).toString("base64");
    const appr = await Promise.all([1, 2, 3, 4].map(async (i) => ({ name: `Carousel/1080x1080/Carousel 1080x1080 - ${i}.jpg`, data: await b64(card(i)) })));
    const live = [{ data: await b64(edited(2)) }, { data: await b64(card(3, 1080)) }, { data: await b64(card(99, 1080)) }];
    const names = await nameLiveImages(live, appr);
    assert.equal(names[0], '"Carousel 1080x1080 - 2" (live 1254×1254)');
    assert.equal(names[1], '"Carousel 1080x1080 - 3" (live 1080×1080)');
    assert.equal(names[2], "live 1080×1080 image, no matching approved file");
    assert.ok(!names.some((n) => /\.(jpg|png)/.test(n)));
  }
  console.log("image-similarity: ok");
})();
