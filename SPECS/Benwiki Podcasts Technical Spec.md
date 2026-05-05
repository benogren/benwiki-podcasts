# Benwiki Podcasts — Technical Spec

Companion to `Benwiki Podcasts PRD.md`. This spec is the source of truth for how the service is built.

## 1. Architecture

```
                    ┌──────────────────────┐
   Benwiki (local)  │   POST /api/episodes │
   ───────────────► │   (Next.js on Vercel)│
   Bearer token     └──────────┬───────────┘
                               │ insert row (status=pending)
                               ▼
                       ┌───────────────┐
                       │ Supabase      │
                       │ Postgres      │
                       └───────┬───────┘
                               │
        ┌──────────────────────┼─────────────────────────┐
        │                      │                         │
        ▼                      ▼                         ▼
┌────────────────┐    ┌────────────────────┐   ┌──────────────────┐
│ Generate worker│    │ Poll worker        │   │  GET /feed/<tok> │
│ (cron, every 1m│    │ (cron, every 2m)   │   │  (Next.js route) │
│  finds pending)│    │ finds generating,  │   │  reads ready eps │
│ → ElevenLabs   │    │  polls ElevenLabs, │   │  → RSS XML       │
│   POST podcast │    │  downloads audio,  │   └──────────────────┘
│ → status=      │    │  uploads to        │
│   generating   │    │  Storage,          │
│                │    │  status=ready      │
└────────────────┘    └────────────────────┘
```

Two cron jobs are scheduled with Supabase `pg_cron`, each invoking a Supabase Edge Function via `pg_net`:
- `generate-pending` — picks up `pending` rows, kicks off ElevenLabs generation
- `poll-generating` — polls ElevenLabs for `generating` rows, downloads audio when done

The webhook and RSS feed live in Next.js API routes on Vercel. Generation/polling live as Supabase Edge Functions because they need scheduled invocation and tolerate longer execution time than Vercel serverless functions.

## 2. Data model

```sql
create type episode_status as enum ('pending', 'generating', 'ready', 'failed');

create table episodes (
  id uuid primary key default gen_random_uuid(),
  episode_number int unique,                 -- assigned on transition to 'ready'
  title text not null,
  description text not null,                 -- short summary for RSS item
  overview text not null,                    -- full text sent to ElevenLabs
  source_refs jsonb,                         -- optional array, from Benwiki
  status episode_status not null default 'pending',
  elevenlabs_project_id text,
  audio_path text,                           -- key in storage bucket
  audio_duration_seconds int,
  audio_size_bytes bigint,
  attempts int not null default 0,
  last_error text,
  published_at timestamptz not null,         -- from Benwiki
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  ready_at timestamptz
);

create index episodes_status_idx on episodes (status);
create index episodes_episode_number_idx on episodes (episode_number desc) where status = 'ready';
```

**Episode number assignment.** When the poll worker transitions a row to `ready`, it runs:
```sql
update episodes
   set episode_number = coalesce((select max(episode_number) from episodes where status = 'ready'), 0) + 1,
       status = 'ready',
       ready_at = now()
 where id = $1;
```
inside a transaction with `lock table episodes in share row exclusive mode` to prevent race conditions. Assigning at the `ready` transition (rather than at insert) avoids gaps in published episode numbers when generation fails.

**Storage bucket:** `episode-audio` (private). Audio files are stored at `episodes/{episode_id}.mp3`. We serve them through a public-but-tokenized signed URL or a passthrough route — see §6.

## 3. Webhook: `POST /api/episodes`

**Auth.** Header: `Authorization: Bearer <BENWIKI_WEBHOOK_TOKEN>`. Constant-time compare against env var. Return 401 on mismatch.

**Request body:**
```json
{
  "title": "string (required, 1–200 chars)",
  "description": "string (required, 1–500 chars)",
  "overview": "string (required, ~5k–30k chars to target ~30 min audio)",
  "source_refs": ["string"],
  "published_at": "2026-05-04T12:00:00Z"
}
```

**Behavior:**
1. Validate auth header → 401 on failure.
2. Parse + validate JSON → 400 on bad shape.
3. Insert row into `episodes` with `status = 'pending'`.
4. Return 202.

**Response (202):**
```json
{ "id": "uuid", "status": "pending" }
```

The webhook intentionally does not call ElevenLabs synchronously — generation happens in the cron worker so the webhook stays fast and idempotent-friendly.

## 4. Generate worker (Supabase Edge Function `generate-pending`)

**Schedule:** every 1 minute (pg_cron).

**Logic:**
```
for each row in episodes where status = 'pending' and attempts < 3:
  call ElevenLabs POST /v1/studio/podcasts with:
    - model_id: <configured>
    - mode: { type: "conversation", host_voice_id: <env>, guest_voice_id: <env> }
    - source: { type: "text", text: row.overview }
    - duration_scale: "long"
    - quality_preset: "high"
  if 2xx:
    update row set status='generating', elevenlabs_project_id=<project_id>, attempts=attempts+1
  else:
    update row set last_error=<resp_body>, attempts=attempts+1
    if attempts >= 3: status='failed'
```

ElevenLabs auth header: `xi-api-key: <ELEVENLABS_API_KEY>`.

## 5. Poll worker (Supabase Edge Function `poll-generating`)

**Schedule:** every 2 minutes (pg_cron).

**Logic:**
```
for each row in episodes where status = 'generating':
  GET ElevenLabs project status (https://api.elevenlabs.io/v1/studio/projects/{project_id})
  switch creation_meta.status:
    case 'finished':
      - download generated audio (endpoint TBD during build, see §10)
      - upload to Supabase Storage at episodes/{id}.mp3
      - probe duration (e.g. with `music-metadata` or Content-Duration header)
      - in a transaction: assign episode_number (max+1), set status='ready', audio_path, audio_duration_seconds, audio_size_bytes, ready_at=now()
    case 'failed':
      - increment attempts; clear elevenlabs_project_id
      - if attempts < 3: status='pending'  (generate worker will retry)
      - else: status='failed', store last_error
    case 'pending'|'creating'|'in_queue'|'converting':
      - no-op (will check next cycle)
```

## 6. RSS feed: `GET /feed/<token>.xml`

**Auth.** The `<token>` path segment is compared (constant-time) against `RSS_FEED_TOKEN`. Mismatch → 404 (not 401, to avoid revealing the route exists).

**Response.** `Content-Type: application/rss+xml; charset=utf-8`. Cache: `public, max-age=300`.

**Body shape (RSS 2.0 + iTunes namespace):**
```xml
<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0"
     xmlns:itunes="http://www.itunes.com/dtds/podcast-1.0.dtd"
     xmlns:content="http://purl.org/rss/1.0/modules/content/">
  <channel>
    <title>Benwiki Podcasts</title>
    <link>https://&lt;host&gt;</link>
    <language>en-us</language>
    <itunes:author>Ben Ogren</itunes:author>
    <itunes:summary>Auto-generated podcast episodes from my Benwiki knowledge base.</itunes:summary>
    <itunes:owner>
      <itunes:name>Ben Ogren</itunes:name>
      <itunes:email>ben@ogren.me</itunes:email>
    </itunes:owner>
    <itunes:image href="https://&lt;host&gt;/cover.jpg"/>
    <itunes:category text="Technology"/>
    <itunes:explicit>false</itunes:explicit>

    <!-- one <item> per ready episode, ordered by episode_number desc -->
    <item>
      <title>{title}</title>
      <description>{description}</description>
      <pubDate>{published_at as RFC 822}</pubDate>
      <guid isPermaLink="false">{episode.id}</guid>
      <enclosure url="{audio_url}" length="{audio_size_bytes}" type="audio/mpeg"/>
      <itunes:duration>{audio_duration_seconds}</itunes:duration>
      <itunes:episode>{episode_number}</itunes:episode>
      <itunes:explicit>false</itunes:explicit>
    </item>
    ...
  </channel>
</rss>
```

**Audio URL.** Two options; pick during build:
- (a) Long-lived signed URL from Supabase Storage embedded directly in the enclosure
- (b) Passthrough route `GET /audio/<episode_id>.mp3` on Vercel that streams from Storage

(b) gives stable URLs that don't rotate when signing keys change — preferred.

## 7. Auth & secrets

**Service env vars (Vercel + Supabase):**
- `SUPABASE_URL`
- `SUPABASE_SERVICE_ROLE_KEY` — used by API routes and edge functions, never exposed to client
- `BENWIKI_WEBHOOK_TOKEN` — random 32-byte hex, shared with Benwiki
- `RSS_FEED_TOKEN` — random 32-byte hex, used in feed URL
- `ELEVENLABS_API_KEY`
- `ELEVENLABS_MODEL_ID` (e.g. `eleven_multilingual_v2` — confirm during build)
- `ELEVENLABS_HOST_VOICE_ID` — TBD
- `ELEVENLABS_GUEST_VOICE_ID` — TBD
- `PODCAST_TITLE` = "Benwiki Podcasts"
- `PODCAST_AUTHOR` = "Ben Ogren"
- `PODCAST_OWNER_EMAIL` = "benjamin.ogren@gmail.com"
- `PODCAST_BASE_URL` = "https://&lt;vercel-host&gt;"
- `PODCAST_COVER_URL` = public URL of the cover image

**Benwiki env vars (local):**
- `BENWIKI_PODCASTS_WEBHOOK_URL` — full URL to `POST /api/episodes`
- `BENWIKI_PODCASTS_TOKEN` — same value as `BENWIKI_WEBHOOK_TOKEN`

Both stored in `.env` locally (gitignored). Compare tokens in constant time on the server.

## 8. Retry policy

- Webhook insert always succeeds if request is well-formed (no external dependency).
- Generate worker: 3 attempts. Each ElevenLabs `POST /v1/studio/podcasts` failure increments `attempts`. After 3 failures, row is marked `failed`.
- Poll worker: if ElevenLabs reports the project as `failed`, the row goes back to `pending` so the generate worker re-creates it (counts toward the same 3-attempt budget).
- `failed` rows are terminal; surface them by querying `select * from episodes where status='failed'` in the Supabase console.

## 9. Project layout

```
benwiki-pods/
├── SPECS/
│   ├── Benwiki Podcasts PRD.md
│   └── Benwiki Podcasts Technical Spec.md
├── app/
│   ├── api/
│   │   └── episodes/route.ts          # POST webhook
│   ├── feed/
│   │   └── [token]/route.ts           # GET RSS
│   └── audio/
│       └── [id]/route.ts              # GET audio passthrough (option b)
├── supabase/
│   ├── migrations/
│   │   └── 0001_init.sql               # schema from §2
│   └── functions/
│       ├── generate-pending/
│       │   └── index.ts
│       └── poll-generating/
│           └── index.ts
├── lib/
│   ├── supabase.ts                     # service-role client
│   ├── elevenlabs.ts                   # API wrapper
│   └── rss.ts                          # RSS XML builder
├── public/
│   └── cover.jpg                       # show cover (3000×3000)
├── package.json
├── next.config.js
└── .env.example
```

## 10. Implementation milestones

1. **Bootstrap.** Init Next.js (App Router, TypeScript), Supabase project, deploy empty Vercel project. Apply migration in §2.
2. **Webhook.** Build `POST /api/episodes` with bearer auth + validation. Manually `curl` to insert a row.
3. **ElevenLabs wrapper.** Build `lib/elevenlabs.ts` covering create-podcast, get-project-status, download-audio. Verify exact download endpoint against ElevenLabs docs (the create-podcast docs don't spell it out — likely `/v1/studio/projects/{id}/audio` or via the project's chapter download).
4. **Generate worker.** Edge function + pg_cron schedule. Manually trigger via `select cron.schedule(...)` and confirm a row moves `pending → generating`.
5. **Poll worker.** Edge function + pg_cron schedule. Confirm `generating → ready` with audio in Storage and episode_number assigned.
6. **RSS feed.** `GET /feed/<token>.xml` reading from Postgres. Validate XML against an RSS validator and subscribe from a real podcast app (Overcast / Apple Podcasts) to confirm.
7. **Audio passthrough.** `GET /audio/<id>.mp3` streaming from Storage with proper `Content-Type` and `Content-Length`.
8. **Wire up Benwiki.** Add the webhook call to Benwiki's pipeline; smoke-test end to end.
9. **Cover image.** Drop final cover into `public/cover.jpg`, set `PODCAST_COVER_URL`.

## 11. Future enhancements (not v1)

- Magic-link auth + minimal admin UI (regenerate, delete, see status, paste-to-generate)
- Switch poll worker to ElevenLabs `callback_url` webhook
- Episode retention / auto-delete after N days
- Per-episode artwork
- Submit feed to Apple Podcasts / Spotify directories
- Multi-feed support (different topics → different feeds)

## 12. Open items to resolve during build

- Confirm exact ElevenLabs audio download endpoint and response shape
- Pick `model_id`, host & guest voice IDs
- Decide between signed URL vs audio passthrough (§6) — recommend passthrough
- Provide final cover image
