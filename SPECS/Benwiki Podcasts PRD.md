## Problem
My AI wiki / knowledge base, called Benwiki, is getting massive and I'm having a hard time staying up to date on it. I'm generally an auditory learner — I like podcasts, or having Speechify read web articles to me. I want a way to consume new Benwiki content as podcast episodes in my regular podcast app.

## Solution
A new service ("Benwiki Podcasts") that turns long-form overview documents from Benwiki into a private podcast feed.

When Benwiki finishes ingesting/processing content, it generates an overview document (long enough to produce a ~30-minute podcast) and POSTs it to this service's webhook. This service stores the episode, calls ElevenLabs to generate a conversational two-host podcast, stores the resulting audio, and exposes it as a tokenized public RSS feed I can subscribe to from any podcast app.

## Users
Single user (me). No multi-tenancy in v1.

## Scope (v1)
**In scope:**
- Webhook endpoint that receives overview documents from Benwiki
- Bearer-token auth on the webhook
- Episode storage in Supabase (Postgres + Storage)
- ElevenLabs conversational multi-host podcast generation
- Cron-based polling for generation completion + audio download
- Auto-retry (up to 3 attempts) on generation failure
- Tokenized public RSS feed compatible with standard podcast apps
- Auto-incrementing episode numbers (assigned server-side on transition to "ready")
- Single show-level cover image used for every episode
- Feed includes all "ready" episodes (no truncation)

**Out of scope (v1):**
- Web UI / dashboard (monitoring done via Supabase + ElevenLabs consoles)
- User authentication / magic link login (deferred until a UI exists)
- Multi-user support
- Episode retention / auto-deletion (revisit later)
- Listing in public podcast directories (Apple Podcasts, etc.)
- Manual regeneration / deletion via UI (do it directly in the DB if needed)

## Inputs
Benwiki POSTs a JSON payload containing:
- `title` — episode title (Benwiki-generated)
- `description` — short summary, ~1–2 sentences, used as the RSS episode description
- `overview` — full long-form text used as the podcast source (sized for ~30 min audio)
- `source_refs` — optional array of source identifiers (URLs, wiki page IDs)
- `published_at` — ISO 8601 timestamp

This service does not generate any of the content — it assumes Benwiki sends everything needed.

## Output
A tokenized RSS 2.0 feed (with iTunes podcast namespace extensions) at a URL like:
`https://<host>/feed/<random-token>.xml`

The feed lists every "ready" episode in reverse chronological order. The token is the only access control — anyone with the URL can subscribe. Treat it like a password.

## Frequency
Benwiki posts roughly every few days. Generation failures retry automatically up to 3 times before the episode is marked failed.

## Tech Stack
- **Vercel** — hosts the webhook API and the RSS feed (Next.js API routes)
- **Supabase** — Postgres (episode metadata), Storage (audio files + cover image), and pg_cron (polling job)
- **ElevenLabs** — conversational two-host podcast generation via `/v1/studio/podcasts`

## Open items
- Host voice IDs (TBD — pick from ElevenLabs voice library during build)
- Show cover image (3000×3000 JPG/PNG — provide before launch)
- Show metadata: title = "Benwiki Podcasts", author = "Ben Ogren"
