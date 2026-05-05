import { NextRequest, NextResponse } from "next/server";
import { getServiceClient } from "@/lib/supabase";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const BUCKET = "episode-audio";

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id: rawId } = await params;
  const id = rawId.endsWith(".mp3") ? rawId.slice(0, -4) : rawId;

  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) {
    return new NextResponse("Not Found", { status: 404 });
  }

  const supabase = getServiceClient();
  const { data: episode, error } = await supabase
    .from("episodes")
    .select("audio_path, audio_size_bytes, status")
    .eq("id", id)
    .maybeSingle();

  if (error || !episode || episode.status !== "ready" || !episode.audio_path) {
    return new NextResponse("Not Found", { status: 404 });
  }

  const { data: blob, error: dlError } = await supabase.storage
    .from(BUCKET)
    .download(episode.audio_path);

  if (dlError || !blob) {
    return new NextResponse("Not Found", { status: 404 });
  }

  const stream = blob.stream();
  const headers: Record<string, string> = {
    "Content-Type": "audio/mpeg",
    "Cache-Control": "public, max-age=31536000, immutable",
    "Accept-Ranges": "bytes",
  };
  if (episode.audio_size_bytes) {
    headers["Content-Length"] = String(episode.audio_size_bytes);
  }

  return new NextResponse(stream as unknown as ReadableStream, {
    status: 200,
    headers,
  });
}
