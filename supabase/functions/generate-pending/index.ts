import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const ELEVENLABS_API_KEY = Deno.env.get("ELEVENLABS_API_KEY")!;
const ELEVENLABS_MODEL_ID =
  Deno.env.get("ELEVENLABS_MODEL_ID") ?? "eleven_multilingual_v2";
const HOST_VOICE_ID = Deno.env.get("ELEVENLABS_HOST_VOICE_ID")!;
const GUEST_VOICE_ID = Deno.env.get("ELEVENLABS_GUEST_VOICE_ID")!;

const MAX_ATTEMPTS = 3;
const BATCH_SIZE = 1;
const TTS_CONCURRENCY = 5;
const BUCKET = "episode-audio";
const BITRATE_BYTES_PER_SEC = 16000; // mp3_44100_128 = 128 kbps

type DialogueLine = { speaker: "host" | "guest"; text: string };

type EpisodeRow = {
  id: string;
  attempts: number;
  dialogue: DialogueLine[];
};

async function ttsLine(line: DialogueLine): Promise<Uint8Array> {
  const voiceId = line.speaker === "host" ? HOST_VOICE_ID : GUEST_VOICE_ID;
  const url = `https://api.elevenlabs.io/v1/text-to-speech/${voiceId}?output_format=mp3_44100_128`;
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "xi-api-key": ELEVENLABS_API_KEY,
      "Content-Type": "application/json",
      "Accept": "audio/mpeg",
    },
    body: JSON.stringify({
      text: line.text,
      model_id: ELEVENLABS_MODEL_ID,
    }),
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`tts ${res.status}: ${body.slice(0, 500)}`);
  }
  return new Uint8Array(await res.arrayBuffer());
}

async function renderDialogue(dialogue: DialogueLine[]): Promise<Uint8Array> {
  const audio: Uint8Array[] = new Array(dialogue.length);
  for (let i = 0; i < dialogue.length; i += TTS_CONCURRENCY) {
    const slice = dialogue.slice(i, i + TTS_CONCURRENCY);
    const chunks = await Promise.all(slice.map(ttsLine));
    for (let j = 0; j < chunks.length; j++) audio[i + j] = chunks[j];
  }
  const total = audio.reduce((s, a) => s + a.length, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const c of audio) {
    out.set(c, off);
    off += c.length;
  }
  return out;
}

async function processOne(
  supabase: ReturnType<typeof createClient>,
  ep: EpisodeRow
): Promise<{ id: string; ok: boolean; detail: string }> {
  // Atomically claim: only succeeds if status is still 'pending'
  const { data: claimed, error: claimErr } = await supabase
    .from("episodes")
    .update({ status: "generating", attempts: ep.attempts + 1 })
    .eq("id", ep.id)
    .eq("status", "pending")
    .select("id")
    .maybeSingle();

  if (claimErr) return { id: ep.id, ok: false, detail: `claim error: ${claimErr.message}` };
  if (!claimed) return { id: ep.id, ok: false, detail: "already claimed" };

  try {
    if (!Array.isArray(ep.dialogue) || ep.dialogue.length === 0) {
      throw new Error("dialogue is empty");
    }

    const audio = await renderDialogue(ep.dialogue);
    const path = `episodes/${ep.id}.mp3`;

    const { error: upErr } = await supabase.storage
      .from(BUCKET)
      .upload(path, audio, { contentType: "audio/mpeg", upsert: true });
    if (upErr) throw new Error(`storage upload: ${upErr.message}`);

    const durationSec = Math.round(audio.length / BITRATE_BYTES_PER_SEC);

    const { data: maxRow } = await supabase
      .from("episodes")
      .select("episode_number")
      .eq("status", "ready")
      .order("episode_number", { ascending: false })
      .limit(1)
      .maybeSingle();
    const nextNumber = ((maxRow?.episode_number as number | null) ?? 0) + 1;

    const { error: finalErr } = await supabase
      .from("episodes")
      .update({
        status: "ready",
        episode_number: nextNumber,
        audio_path: path,
        audio_size_bytes: audio.length,
        audio_duration_seconds: durationSec,
        ready_at: new Date().toISOString(),
        last_error: null,
      })
      .eq("id", ep.id);
    if (finalErr) throw new Error(`final update: ${finalErr.message}`);

    return {
      id: ep.id,
      ok: true,
      detail: `episode ${nextNumber}, ${audio.length} bytes, ~${durationSec}s`,
    };
  } catch (e) {
    const newAttempts = ep.attempts + 1;
    await supabase
      .from("episodes")
      .update({
        status: newAttempts >= MAX_ATTEMPTS ? "failed" : "pending",
        last_error: String(e).slice(0, 1000),
      })
      .eq("id", ep.id);
    return { id: ep.id, ok: false, detail: String(e).slice(0, 200) };
  }
}

Deno.serve(async () => {
  const supabase = createClient(SUPABASE_URL, SERVICE_ROLE, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  const { data, error } = await supabase
    .from("episodes")
    .select("id, attempts, dialogue")
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

  return new Response(JSON.stringify({ processed: results.length, results }), {
    headers: { "Content-Type": "application/json" },
  });
});
