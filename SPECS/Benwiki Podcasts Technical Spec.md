# Benwiki Podcasts — Technical Spec

Companion to `Benwiki Podcasts PRD.md`. This spec is the source of truth for how the service is built.

> **Architecture note (2026-05-05).** This spec was rewritten after dropping ElevenLabs Studio API in favor of a roll-your-own TTS pipeline. ElevenLabs Studio (the conversational podcast endpoint) requires explicit account whitelisting that we couldn't get on a standard plan. Benwiki now generates the host/guest dialogue itself and posts it as a JSON array; this service renders each line via the standard `/v1/text-to-speech` endpoint and concatenates the chunks. See git history (`b54258b` and forward) for the prior Studio-based design.

## 1. Architecture

```
                    ┌──────────────────────┐
   Benwiki (local)  │   POST /api/episodes │
   ───────────────► │   (Next.js on Vercel)│
   Bearer token     └──────────┬───────────┘
   {dialogue: [...]}           │ insert row (status=pending)
                               ▼
                       ┌───────────────┐
                       │ Supabase      │
                       │ Postgres      │
                       └───────┬───────┘
                               │
        ┌──────────────────────┴─────────────────────────┐
        │                                                │
        ▼                                                ▼
┌──────────────────────────┐              ┌────────────────────────┐
│ generate-pending         │              │  GET /feed/<token>.xml │
│ (Supabase Edge Function, │              │  (Next.js route)       │
│  scheduled by pg_cron)   │              │  reads ready episodes  │
│                          │              │  → RSS XML             │
│ for each pending row:    │              └────────────────────────┘
│  • atomically claim      │
│  • render each line via  │              ┌────────────────────────┐
│    ElevenLabs TTS        │              │  GET /audio/<id>.mp3   │
│    (per-voice serial,    │              │  (Next.js route)       │
│     parallel by voice)   │              │  streams from Storage  │
│  • concatenate MP3s      │              └────────────────────────┘
│  • upload to Storage     │
│  • assign episode_number │
│  • mark ready            │
└──────────────────────────┘
```

A **single** edge function (`generate-pending`) runs the whole pipeline synchronously per row. There's no separate poll/wait stage — the standard TTS endpoint returns audio bytes immediately, so the function can render, concatenate, and finalize in one invocation.

The webhook and RSS feed live as Next.js API routes on Vercel. The TTS pipeline lives in a Supabase Edge Function because a 30-minute episode renders in ~30–60 seconds and would brush against Vercel serverless timeouts.

## 2. Data model

```sql
create type episode_status as enum ('pending', 'generating', 'ready', 'failed');

create table episodes (
  id uuid primary key default gen_random_uuid(),
  episode_number int unique,
  title text not null,
  description text not null,
  dialogue jsonb not null default '[]'::jsonb,
  source_refs jsonb,
  status episode_status not null default 'pending',
  audio_path text,
  audio_duration_seconds int,
  audio_size_bytes bigint,
  attempts int not null default 0,
  last_error text,
  published_at timestamptz not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  ready_at timestamptz
);

create index episodes_status_idx on episodes (status);
create index episodes_episode_number_idx on episodes (episode_number desc) where status = 'ready';
```

`updated_at` is maintained by a `before update` trigger.

**`dialogue`** is a JSONB array of `{speaker: "host"|"guest", text: string}` objects, in render order. See `Benwiki Integration Spec.md` for content rules.

**Episode number assignment.** Computed in the worker as `(SELECT MAX(episode_number) FROM episodes WHERE status='ready') + 1`, applied at the moment the row transitions to `ready`. Race window with multiple concurrent workers is real but extremely narrow given `BATCH_SIZE = 1` and a single-user setup; the unique constraint on `episode_number` prevents collisions if it ever happens.

**Storage bucket:** `episode-audio` (private). Audio files at `episodes/{episode_id}.mp3`. Served via a passthrough route on Vercel (`/audio/<id>.mp3`) that streams from Storage with a stable URL.

## 3. Webhook: `POST /api/episodes`

**Auth.** `Authorization: Bearer <BENWIKI_WEBHOOK_TOKEN>`. Constant-time compare. 401 on mismatch.

**Request body** (validated with Zod):
```json
{
  "title": "string (1–200 chars, required)",
  "description": "string (1–500 chars, required)",
  "dialogue": [
    { "speaker": "host" | "guest", "text": "string (1–2000 chars)" }
  ],
  "source_refs": ["string", "..."],
  "published_at": "2026-05-05T12:00:00Z"
}
```

`dialogue` must be an array of 1–500 lines. See `Benwiki Integration Spec.md` for content guidance and length targets.

**Behavior:**
1. Validate auth → 401.
2. Parse + validate JSON → 400.
3. Insert row with `status = 'pending'`.
4. Return 202 with `{id, status}`.

The webhook never calls ElevenLabs synchronously — the TTS pipeline runs async, decoupled from the webhook so it stays fast.

## 4. Generate worker (Supabase Edge Function `generate-pending`)

**Schedule:** every 1 minute (pg_cron — see §10).

**Per-invocation flow** (one episode at a time, `BATCH_SIZE = 1`):

1. Select the oldest `pending` row with `attempts < MAX_ATTEMPTS` (3).
2. **Atomically claim** by `UPDATE episodes SET status='generating', attempts=attempts+1 WHERE id=$1 AND status='pending'`. If the update affects 0 rows, another invocation got there first — skip.
3. **Render dialogue.** Group lines by speaker into two queues. Run both queues in parallel; within each queue, render lines sequentially (ElevenLabs returns 409 `already_running` if two requests for the same voice ID are in flight).
   ```
   await Promise.all([
     processVoiceQueue(hostLines),    // sequential, host voice
     processVoiceQueue(guestLines),   // sequential, guest voice
   ]);
   ```
   Each TTS call hits `POST /v1/text-to-speech/{voice_id}?output_format=mp3_44100_128` with `model_id` and `text`. Returns MP3 bytes.
4. **Concatenate** MP3 chunks in original line order (naive byte concat — works because all chunks share the same encoding params).
5. **Upload** to Storage at `episodes/{id}.mp3`.
6. **Compute duration** as `bytes / 16000` (128 kbps → 16,000 bytes/sec).
7. **Assign episode_number** = `MAX(episode_number) + 1` over `status='ready'` rows.
8. **Mark ready** with `audio_path`, `audio_size_bytes`, `audio_duration_seconds`, `ready_at`.

**Error handling.** Any thrown error inside the try block:
- Increments `attempts`.
- If `attempts >= MAX_ATTEMPTS`: status=`failed`, store `last_error`.
- Otherwise: status=`pending` (cron will retry).

**Model choice.** `ELEVENLABS_MODEL_ID` defaults to `eleven_turbo_v2_5` — low-latency model that renders ~30 min of audio in ~40s of wall clock. Sticking with the slower `eleven_multilingual_v2` would push 100+ line episodes past the edge function's 150s idle timeout. If you want higher-quality voices, see §11 for chunked-processing as the path forward.

**Sizing assumption.** Dialogue lengths up to ~150 lines fit comfortably in a single edge function invocation with the turbo model. Beyond that, see §11.

## 5. RSS feed: `GET /feed/<token>.xml`

**Auth.** Path-segment token, constant-time compared against `RSS_FEED_TOKEN`. Mismatch → 404 (not 401, to avoid revealing the route).

**Response.** `Content-Type: application/rss+xml; charset=utf-8`. `Cache-Control: public, max-age=300`.

**Body shape:** RSS 2.0 + iTunes namespace. One `<item>` per `status='ready'` episode, ordered by `episode_number desc`. Channel-level metadata (title, author, owner, image, category) sourced from `PODCAST_*` env vars. Item-level fields:
- `<title>` ← `episodes.title`
- `<description>` ← `episodes.description`
- `<pubDate>` ← `episodes.published_at` (RFC 822)
- `<guid>` ← `episodes.id` (uuid, `isPermaLink=false`)
- `<enclosure>` ← `{baseUrl}/audio/{id}.mp3`, length = `audio_size_bytes`
- `<itunes:duration>` ← formatted `audio_duration_seconds`
- `<itunes:episode>` ← `episode_number`

## 6. Audio passthrough: `GET /audio/<id>.mp3`

Streams `episodes/{id}.mp3` from the private Storage bucket using the service-role Supabase client. Validates the id is a UUID and the row's `status='ready'` before serving. Sets `Cache-Control: public, max-age=31536000, immutable` (file content is immutable per episode id) and `Accept-Ranges: bytes`.

## 7. Auth & secrets

**Service env vars (Vercel):**
- `SUPABASE_URL`
- `SUPABASE_SERVICE_ROLE_KEY` — must be the `sb_secret_...` value (the publishable key cannot read private storage buckets)
- `BENWIKI_WEBHOOK_TOKEN` — random 32-byte hex, shared with Benwiki
- `RSS_FEED_TOKEN` — random 32-byte hex, embedded in the feed URL path
- `PODCAST_TITLE`, `PODCAST_AUTHOR`, `PODCAST_OWNER_EMAIL`, `PODCAST_DESCRIPTION`, `PODCAST_LANGUAGE`, `PODCAST_CATEGORY`
- `PODCAST_BASE_URL` — production URL of the deployment (used for RSS enclosure links and channel `<link>`)
- `PODCAST_COVER_URL` — public URL of the cover image (e.g. `{PODCAST_BASE_URL}/cover.png`)

**Edge function secrets (Supabase, set via `supabase secrets set`):**
- `ELEVENLABS_API_KEY`
- `ELEVENLABS_MODEL_ID` — default `eleven_turbo_v2_5`
- `ELEVENLABS_HOST_VOICE_ID`
- `ELEVENLABS_GUEST_VOICE_ID`

`SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` are auto-injected into edge functions by Supabase — don't set them manually.

**Benwiki env vars (local on the producer side):**
- `BENWIKI_PODCASTS_WEBHOOK_URL` — the production webhook URL
- `BENWIKI_PODCASTS_TOKEN` — same value as service-side `BENWIKI_WEBHOOK_TOKEN`

## 8. Retry policy

- **Webhook:** Insert always succeeds for valid payloads (no external dependency). Validation errors are 400; auth errors are 401.
- **TTS pipeline:** 3 attempts per row. Failures (network errors, ElevenLabs errors, storage errors) increment `attempts` and reset status to `pending`. After 3 failures, row goes to `failed` with `last_error` populated. `failed` is terminal — surface them by querying `SELECT * FROM episodes WHERE status='failed'` in the Supabase console.

## 9. Project layout

```
benwiki-pods/
├── SPECS/
│   ├── Benwiki Podcasts PRD.md
│   ├── Benwiki Podcasts Technical Spec.md   # this file
│   └── Benwiki Integration Spec.md          # for Benwiki repo
├── app/
│   ├── api/episodes/route.ts                # POST webhook
│   ├── audio/[id]/route.ts                  # GET audio passthrough
│   ├── feed/[token]/route.ts                # GET RSS
│   ├── layout.tsx, page.tsx                 # placeholder homepage
│   └── globals.css
├── lib/
│   ├── supabase.ts                          # service-role client + EpisodeRow type
│   ├── auth.ts                              # constant-time bearer check
│   └── rss.ts                               # RSS XML builder
├── supabase/
│   ├── migrations/
│   │   ├── 20260504190000_init.sql          # schema, trigger, storage bucket
│   │   └── 20260505030000_dialogue_pipeline.sql  # drop overview, add dialogue
│   ├── functions/generate-pending/index.ts  # TTS pipeline (Deno edge function)
│   └── config.toml
├── public/cover.png                         # show cover (1254×1254)
├── .env.example
├── next.config.ts, tsconfig.json
├── package.json, pnpm-lock.yaml
└── README.md
```

## 10. Cron schedule (pending — pg_cron + pg_net)

Once everything is operational, schedule the function to run automatically. Paste this into the Supabase SQL Editor:

```sql
create extension if not exists pg_cron with schema extensions;
create extension if not exists pg_net    with schema extensions;

-- Store the service role key in Supabase Vault (one-time)
select vault.create_secret(
  '<sb_secret_... value>',
  'service_role_key',
  'Used by pg_cron to invoke the generate-pending edge function'
);

-- Schedule
select cron.schedule(
  'generate-pending',
  '* * * * *',  -- every minute
  $$
  select net.http_post(
    url := 'https://<project-ref>.supabase.co/functions/v1/generate-pending',
    headers := jsonb_build_object(
      'Content-Type',  'application/json',
      'Authorization', 'Bearer ' || (select decrypted_secret from vault.decrypted_secrets where name = 'service_role_key')
    )
  );
  $$
);
```

To disable: `select cron.unschedule('generate-pending');`

## 11. Known limitations / future enhancements

- **No chunked processing.** Episodes >~150 lines (~45 min audio) may hit the edge function's 150s idle timeout. If that becomes a blocker:
  - Add `next_line_index int` column.
  - Per invocation, render up to a time budget; persist per-line MP3 chunks at `episodes/{id}/chunks/{i}.mp3`; advance `next_line_index`.
  - When `next_line_index === dialogue.length`, do a finalization invocation that downloads all chunks, concatenates, uploads, marks ready, deletes partials.
  - Allow worker query to pick up `status='generating'` rows whose `updated_at` is older than ~5 minutes (treat as stale and resume).
- **Stuck `generating` rows.** If an invocation crashes after claiming, the row sits in `generating` indefinitely. For now: detect manually via `SELECT * FROM episodes WHERE status='generating' AND updated_at < now() - interval '10 minutes'` and reset to `pending`. Auto-recovery would tie into the chunked-processing work above.
- **No web UI.** Monitoring is via Supabase Table Editor + Function Logs. A minimal admin UI (regenerate, retry-failed, paste-to-generate) would unlock magic-link auth (deferred from v1).
- **Magic-link auth deferred.** PRD mentioned magic links; we skipped for v1 since there's no UI. When the UI exists, swap the no-auth homepage for a Supabase auth wall.
- **No silence between speaker turns.** Lines run back-to-back with whatever pause ElevenLabs's punctuation handling provides. If the cadence sounds rushed, insert ~300ms of silence between turns by appending a precomputed silent MP3 chunk in the concat step.
- **Single show.** All episodes go into one feed. Multi-feed support (e.g. a separate feed per Benwiki tag/topic) would require a `show_id` column and a parameterized RSS route.
- **Quality vs. speed.** `eleven_turbo_v2_5` was chosen for latency. Higher-quality alternatives (`eleven_multilingual_v2`, `eleven_v3`) require chunked processing for non-trivial episodes.

## 12. Implementation status

| Milestone | Status |
|---|---|
| 1. Bootstrap (Next.js, Supabase, schema) | ✅ |
| 2. Webhook with auth + Zod validation | ✅ |
| 3. ElevenLabs integration (TTS, per-voice queue) | ✅ |
| 4. Generate worker (edge function) | ✅ |
| 5. RSS feed | ✅ |
| 6. Audio passthrough | ✅ |
| 7. Vercel + Supabase deploy | ✅ |
| 8. Cover image + show metadata | ✅ |
| 9. pg_cron schedule (§10) | ✅ |
| 10. Wire up Benwiki to the production webhook | ⏳ Producer-side work |
