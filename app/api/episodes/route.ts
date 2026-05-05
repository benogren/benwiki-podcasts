import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { checkBearerToken } from "@/lib/auth";
import { getServiceClient } from "@/lib/supabase";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const PayloadSchema = z.object({
  title: z.string().min(1).max(200),
  description: z.string().min(1).max(500),
  overview: z.string().min(1),
  source_refs: z.array(z.string()).optional(),
  published_at: z.string().datetime(),
});

export async function POST(req: NextRequest) {
  const expected = process.env.BENWIKI_WEBHOOK_TOKEN;
  if (!expected) {
    return NextResponse.json(
      { error: "server misconfigured: BENWIKI_WEBHOOK_TOKEN not set" },
      { status: 500 }
    );
  }

  if (!checkBearerToken(req.headers.get("authorization"), expected)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid json" }, { status: 400 });
  }

  const parsed = PayloadSchema.safeParse(raw);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "invalid payload", issues: parsed.error.issues },
      { status: 400 }
    );
  }

  const supabase = getServiceClient();
  const { data, error } = await supabase
    .from("episodes")
    .insert({
      title: parsed.data.title,
      description: parsed.data.description,
      overview: parsed.data.overview,
      source_refs: parsed.data.source_refs ?? null,
      published_at: parsed.data.published_at,
    })
    .select("id, status")
    .single();

  if (error) {
    return NextResponse.json(
      { error: "failed to insert episode", detail: error.message },
      { status: 500 }
    );
  }

  return NextResponse.json(
    { id: data.id, status: data.status },
    { status: 202 }
  );
}
