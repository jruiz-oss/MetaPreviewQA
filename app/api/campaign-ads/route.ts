import { NextResponse } from "next/server";
import { fetchCampaignAdsList } from "@/lib/meta-api";

export async function POST(request: Request) {
  const { campaignId, activeOnly, sinceDate } = (await request.json()) as {
    campaignId: string;
    activeOnly?: boolean;
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

  const { ads, error, totalFetched, skippedInactive, skippedOld } =
    await fetchCampaignAdsList(campaignId.trim(), accessToken, {
      activeOnly: activeOnly ?? true,
      sinceDate: sinceDate?.trim() || undefined,
    });

  if (error) {
    return NextResponse.json({ error }, { status: 400 });
  }

  if (ads.length === 0) {
    // Distinguish "campaign is empty" from "everything was filtered out" so the
    // user knows to relax the active-only toggle or date cutoff rather than
    // doubting the campaign ID.
    const filteredOut = skippedInactive + skippedOld;
    const msg =
      filteredOut > 0
        ? `No ads matched the filters — ${skippedInactive} inactive and ${skippedOld} created before the cutoff were skipped (${totalFetched} total in campaign). Turn off "Active only" or clear the date to include them.`
        : "No ads found under this campaign ID.";
    return NextResponse.json({ error: msg }, { status: 404 });
  }

  return NextResponse.json({ ads, totalFetched, skippedInactive, skippedOld });
}
