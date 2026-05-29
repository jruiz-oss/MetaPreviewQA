import { NextResponse } from "next/server";
import { fetchCampaignAdsList } from "@/lib/meta-api";

export async function POST(request: Request) {
  const { campaignId } = (await request.json()) as { campaignId: string };

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

  const { ads, error } = await fetchCampaignAdsList(campaignId.trim(), accessToken);

  if (error) {
    return NextResponse.json({ error }, { status: 400 });
  }

  if (ads.length === 0) {
    return NextResponse.json(
      { error: "No ads found under this campaign ID." },
      { status: 404 }
    );
  }

  return NextResponse.json({ ads });
}
