import { NextRequest, NextResponse } from "next/server";
import { constantTimeEqual } from "@/lib/auth";
import { getServiceClient, type EpisodeRow } from "@/lib/supabase";
import { buildRss, feedConfigFromEnv } from "@/lib/rss";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ token: string }> }
) {
  const { token } = await params;
  const expected = process.env.RSS_FEED_TOKEN;
  if (!expected) {
    return NextResponse.json(
      { error: "server misconfigured: RSS_FEED_TOKEN not set" },
      { status: 500 }
    );
  }

  // Strip optional .xml suffix the user may include
  const provided = token.endsWith(".xml") ? token.slice(0, -4) : token;

  if (!constantTimeEqual(provided, expected)) {
    return new NextResponse("Not Found", { status: 404 });
  }

  const supabase = getServiceClient();
  const { data, error } = await supabase
    .from("episodes")
    .select("*")
    .eq("status", "ready")
    .order("episode_number", { ascending: false });

  if (error) {
    return NextResponse.json(
      { error: "failed to load episodes", detail: error.message },
      { status: 500 }
    );
  }

  const xml = buildRss(feedConfigFromEnv(), (data ?? []) as EpisodeRow[]);

  return new NextResponse(xml, {
    status: 200,
    headers: {
      "Content-Type": "application/rss+xml; charset=utf-8",
      "Cache-Control": "public, max-age=300",
    },
  });
}
