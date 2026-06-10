import { NextResponse } from "next/server";
import { fetchCampaignAdsList } from "@/lib/meta-api";

export async function POST(request: Request) {
  const { campaignId, sinceDate } = (await request.json()) as {
    campaignId: string;
    sinceDate?: string;
  };

  if (!campaignId?.trim()) {
    return NextResponse.json({ error: "Missing campaign ID" }, { status: 400 });
  }

  const accessToken = process.env.META_ACCESS_TOKEN;
  if (!accessToken) {
    return NextResponse.json(
      { error: "META_ACCESS_TOKEN environment variable is not set." },
      { status: 500 }
    );
  }

  const { ads, error, totalFetched, skippedOld, campaignName } = await fetchCampaignAdsList(
    campaignId.trim(),
    accessToken,
    { sinceDate: sinceDate?.trim() || undefined }
  );

  if (error) {
    return NextResponse.json({ error }, { status: 400 });
  }

  if (ads.length === 0) {
    // Distinguish "campaign is empty" from "everything was filtered out by the
    // date cutoff" so the user knows to relax the date rather than doubting the
    // campaign ID.
    const msg =
      skippedOld > 0
        ? `No ads matched — ${skippedOld} of ${totalFetched} haven't been updated since the cutoff date. Move the date earlier or clear it to include them.`
        : "No ads found under this campaign ID.";
    return NextResponse.json({ ads: [], error: msg, totalFetched, skippedOld, campaignName });
  }

  return NextResponse.json({ ads, totalFetched, skippedOld, campaignName });
}
