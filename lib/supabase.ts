import { createClient, type SupabaseClient } from "@supabase/supabase-js";

let cached: SupabaseClient | null = null;

export function getServiceClient(): SupabaseClient {
  if (cached) return cached;

  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!url || !key) {
    throw new Error("SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set");
  }

  cached = createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  return cached;
}

export type EpisodeStatus = "pending" | "generating" | "ready" | "failed";

export type EpisodeRow = {
  id: string;
  episode_number: number | null;
  title: string;
  description: string;
  overview: string;
  source_refs: string[] | null;
  status: EpisodeStatus;
  elevenlabs_project_id: string | null;
  audio_path: string | null;
  audio_duration_seconds: number | null;
  audio_size_bytes: number | null;
  attempts: number;
  last_error: string | null;
  published_at: string;
  created_at: string;
  updated_at: string;
  ready_at: string | null;
};
