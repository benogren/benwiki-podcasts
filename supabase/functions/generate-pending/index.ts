import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const ELEVENLABS_API_KEY = Deno.env.get("ELEVENLABS_API_KEY")!;
const ELEVENLABS_MODEL_ID =
  Deno.env.get("ELEVENLABS_MODEL_ID") ?? "eleven_multilingual_v2";
const ELEVENLABS_HOST_VOICE_ID = Deno.env.get("ELEVENLABS_HOST_VOICE_ID")!;
const ELEVENLABS_GUEST_VOICE_ID = Deno.env.get("ELEVENLABS_GUEST_VOICE_ID")!;

const MAX_ATTEMPTS = 3;
const BATCH_SIZE = 5;

type EpisodeRow = {
  id: string;
  overview: string;
  attempts: number;
};

async function processOne(
  supabase: ReturnType<typeof createClient>,
  ep: EpisodeRow
): Promise<{ id: string; ok: boolean; detail?: string }> {
  const nextAttempts = ep.attempts + 1;

  let res: Response;
  try {
    res = await fetch("https://api.elevenlabs.io/v1/studio/podcasts", {
      method: "POST",
      headers: {
        "xi-api-key": ELEVENLABS_API_KEY,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model_id: ELEVENLABS_MODEL_ID,
        mode: {
          type: "conversation",
          conversation: {
            host_voice_id: ELEVENLABS_HOST_VOICE_ID,
            guest_voice_id: ELEVENLABS_GUEST_VOICE_ID,
          },
        },
        source: { type: "text", text: ep.overview },
        duration_scale: "long",
        quality_preset: "high",
      }),
    });
  } catch (e) {
    await supabase
      .from("episodes")
      .update({
        attempts: nextAttempts,
        last_error: `network: ${String(e).slice(0, 900)}`,
        status: nextAttempts >= MAX_ATTEMPTS ? "failed" : "pending",
      })
      .eq("id", ep.id);
    return { id: ep.id, ok: false, detail: "network error" };
  }

  if (!res.ok) {
    const body = await res.text();
    await supabase
      .from("episodes")
      .update({
        attempts: nextAttempts,
        last_error: `${res.status}: ${body.slice(0, 900)}`,
        status: nextAttempts >= MAX_ATTEMPTS ? "failed" : "pending",
      })
      .eq("id", ep.id);
    return { id: ep.id, ok: false, detail: `http ${res.status}` };
  }

  const json = await res.json();
  const projectId = json?.project?.project_id;
  if (!projectId) {
    await supabase
      .from("episodes")
      .update({
        attempts: nextAttempts,
        last_error: "no project_id in response",
        status: nextAttempts >= MAX_ATTEMPTS ? "failed" : "pending",
      })
      .eq("id", ep.id);
    return { id: ep.id, ok: false, detail: "no project_id" };
  }

  await supabase
    .from("episodes")
    .update({
      status: "generating",
      elevenlabs_project_id: projectId,
      attempts: nextAttempts,
      last_error: null,
    })
    .eq("id", ep.id);

  return { id: ep.id, ok: true, detail: projectId };
}

Deno.serve(async () => {
  const supabase = createClient(SUPABASE_URL, SERVICE_ROLE, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  const { data, error } = await supabase
    .from("episodes")
    .select("id, overview, attempts")
    .eq("status", "pending")
    .lt("attempts", MAX_ATTEMPTS)
    .order("created_at", { ascending: true })
    .limit(BATCH_SIZE);

  if (error) {
    return new Response(
      JSON.stringify({ error: "select failed", detail: error.message }),
      { status: 500, headers: { "Content-Type": "application/json" } }
    );
  }

  const results = [];
  for (const ep of (data ?? []) as EpisodeRow[]) {
    results.push(await processOne(supabase, ep));
  }

  return new Response(
    JSON.stringify({ processed: results.length, results }),
    { headers: { "Content-Type": "application/json" } }
  );
});
