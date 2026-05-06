# Benwiki Podcasts

A private podcast feed generated from my [Benwiki](https://github.com/benogren/benwiki) knowledge base. Benwiki ingests articles and newsletters, drafts a two-host dialogue script, and POSTs it here. This service renders the dialogue to audio with ElevenLabs, stores it, and serves it as an RSS feed I can subscribe to from any podcast app.

Single-user, no UI. Operational monitoring is via the Supabase dashboard.

## Specs

The specs in `SPECS/` are the source of truth for what this service does and how it's built.

- **[`Benwiki Podcasts PRD.md`](./SPECS/Benwiki%20Podcasts%20PRD.md)** — product requirements (the *what* and *why*)
- **[`Benwiki Podcasts Technical Spec.md`](./SPECS/Benwiki%20Podcasts%20Technical%20Spec.md)** — architecture, data model, env vars, milestones (the *how*)
- **[`Benwiki Integration Spec.md`](./SPECS/Benwiki%20Integration%20Spec.md)** — the contract Benwiki must implement (lives here for now; copy into the Benwiki repo when wiring up the producer side)

If you're modifying behavior, update the spec first.

## Deployment

- **Production:** [`benwiki-podcasts.vercel.app`](https://benwiki-podcasts.vercel.app/)
- **Webhook:** `POST /api/episodes` (bearer-token auth)
- **RSS feed:** `GET /feed/<RSS_FEED_TOKEN>.xml`
- **Audio passthrough:** `GET /audio/<episode-id>.mp3`

The pipeline runs across two clouds:
- **Vercel** hosts the webhook, RSS feed, and audio passthrough (Next.js App Router).
- **Supabase** hosts the Postgres database, the private `episode-audio` storage bucket, and the `generate-pending` edge function that does the ElevenLabs TTS rendering.

## Local development

```bash
pnpm install
cp .env.example .env.local
# fill in values — see the technical spec §7 for what each var is
pnpm dev
```

The local dev server runs at `http://localhost:3000` and reads from the same Supabase project as production. To smoke-test the webhook locally:

```bash
TOKEN=$(grep -E '^BENWIKI_WEBHOOK_TOKEN=' .env.local | cut -d= -f2-)
curl -X POST http://localhost:3000/api/episodes \
  -H "Authorization: Bearer ${TOKEN}" \
  -H "Content-Type: application/json" \
  -d @path/to/dialogue-payload.json
```

The edge function only runs on Supabase — it doesn't run locally with `pnpm dev`. Trigger it manually with:

```bash
KEY=$(grep -E '^SUPABASE_SERVICE_ROLE_KEY=' .env.local | cut -d= -f2-)
curl -X POST https://<project-ref>.supabase.co/functions/v1/generate-pending \
  -H "Authorization: Bearer ${KEY}"
```

## Common operations

```bash
# Apply a new migration to the linked Supabase project
supabase db push

# Deploy the edge function after editing it
supabase functions deploy generate-pending

# Update an edge function secret (e.g. swap ElevenLabs voice)
supabase secrets set ELEVENLABS_HOST_VOICE_ID=<new-voice-id>

# See what's in the queue
# (paste in Supabase SQL Editor)
select id, episode_number, status, attempts, last_error, ready_at
  from episodes
  order by created_at desc
  limit 20;

# Reset a stuck row to retry
update episodes
   set status = 'pending', attempts = 0, last_error = null
 where id = '<uuid>';
```

## Stack

- **Next.js 16** (App Router, TypeScript) on Vercel
- **Supabase** for Postgres, Storage, Edge Functions, and pg_cron
- **ElevenLabs** for TTS (`eleven_turbo_v2_5` model by default — see Technical Spec §4)
- **Zod** for webhook payload validation

## Repo conventions

- Specs in `SPECS/` are the source of truth. Edit them before changing behavior.
- `.env.local` is gitignored; `.env.example` is tracked. Keep them in sync when adding new env vars.
- Migrations live in `supabase/migrations/` with `YYYYMMDDHHMMSS_name.sql` naming required by `supabase db push`.
- Edge functions live in `supabase/functions/` — Deno runtime, URL imports. Excluded from the Next.js TypeScript project (see `tsconfig.json`).
