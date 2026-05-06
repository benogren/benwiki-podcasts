# Benwiki → Benwiki Podcasts Integration Spec

This spec lives in the **Benwiki** repo. It describes how Benwiki produces a podcast overview document and posts it to the Benwiki Podcasts service.

The Benwiki Podcasts service treats the payload as authoritative — it does not transform, summarize, or rewrite any content. Whatever Benwiki sends is what gets turned into audio.

## 1. When to fire

After Benwiki finishes its ingest/processing run for a batch of articles or newsletters, it generates one podcast episode covering everything ingested in that run, then POSTs it to the Benwiki Podcasts webhook.

One run = one episode. If a run ingests nothing new, do not post.

## 2. What to generate

Benwiki is responsible for two things:
1. Drafting an overview from the ingested content (internal to Benwiki — never sent over the wire)
2. Turning that overview into a **two-host dialogue script** and posting it as JSON

The downstream service does not transform or rewrite anything. Each line of the dialogue is rendered as audio with a fixed voice, in order, then concatenated.

The payload has these fields:

### `title` (string, 1–200 chars)
The episode title as it will appear in the podcast app. Should be specific and scannable, not generic. Avoid leading dates or "Episode N" — episode numbers are assigned downstream.

Good: `"AI agent harnesses, Anthropic's memory tool, and the rise of skill packs"`
Bad: `"Weekly update"`, `"Episode for May 4"`

### `description` (string, 1–500 chars)
1–2 sentence summary shown in the podcast app's episode list and detail view. Tell a listener what they'll learn and why it's worth 30 minutes. Plain text — no markdown.

### `dialogue` (array of `{speaker, text}` objects, 1–500 lines)
The two-host conversation, in order. Each item:

```json
{ "speaker": "host" | "guest", "text": "What the speaker says, as plain spoken English." }
```

**Speakers.** Exactly two values are accepted: `"host"` and `"guest"`. Each maps to a fixed ElevenLabs voice ID configured on the service side. Don't put names like `"Alice"` here — the audio voices are anonymous. Speaker characterization happens through what they say, not the field value.

**Length per line.** 1–2000 chars. Keep most lines under ~400 chars so the rhythm stays conversational. Long monologues (>1000 chars on one speaker) sound like a lecture; alternate naturally.

**Total length.** Target **~4,500 words across all lines combined** for a ~30-min episode at typical TTS pacing (150 wpm). For most episodes that's 60–150 alternating lines.

**Content guidelines:**
- Open with a hook from the host introducing the theme of this batch
- Structure as a coherent conversation, not a Q&A interrogation. Both speakers should advance ideas, push back, riff, build on each other
- Group related material into "segments" implied by the conversation flow (no need for explicit section markers)
- Spell out acronyms on first use
- Write for spoken rendering: contractions, short sentences, punctuation cues for pauses (commas, em-dashes, periods)
- Each line ends with proper punctuation so TTS produces natural pauses

**Anti-patterns:**
- One-word interjections like `"Right."` or `"Yeah."` — they read as filler in TTS
- URLs, code, or markdown formatting (headings, bullets, asterisks) — TTS will read them out loud literally
- Stage directions like `[laughs]` or `*pause*` — TTS will read those out loud too
- A speaker monopolizing 5+ consecutive lines — break it up with the other speaker

### `source_refs` (array of strings, optional)
URLs and/or wiki page IDs for everything covered in the episode. Used downstream for traceability only — not read in the audio.

### `published_at` (ISO 8601 timestamp)
The moment the run completed. Used as the RSS `pubDate` so podcast apps order episodes correctly.

## 3. HTTP request

```
POST {BENWIKI_PODCASTS_WEBHOOK_URL}
Authorization: Bearer {BENWIKI_PODCASTS_TOKEN}
Content-Type: application/json
```

Body: the JSON object described in §2.

**Current webhook URLs:**
- **Production**: `https://benwiki-podcasts.vercel.app/api/episodes`
- **Local development**: `http://localhost:3000/api/episodes` (when the Benwiki Podcasts service is running via `pnpm dev`)

### Expected responses
- **202 Accepted** — `{ "id": "<uuid>", "status": "pending" }`. Episode queued. Done.
- **400 Bad Request** — payload invalid. Log the response body. Do not retry without fixing the payload.
- **401 Unauthorized** — wrong/missing bearer token. Check `BENWIKI_PODCASTS_TOKEN`.
- **5xx** — service error. Retry up to 3 times with exponential backoff (1s, 4s, 16s). After that, log and move on — the service handles its own generation retries once a row exists, so the only thing Benwiki retries is delivering the webhook.

## 4. Example payload

```json
{
  "title": "AI agent harnesses, Anthropic's memory tool, and the rise of skill packs",
  "description": "This week's reading covered how Claude Code's hook system works, why agent harnesses are converging on a few patterns, and what Anthropic's new memory tool changes for long-running agents.",
  "dialogue": [
    { "speaker": "host", "text": "Welcome back. This week we've got three threads that actually tie together: hooks, harnesses, and the new memory tool from Anthropic. Where do you want to start?" },
    { "speaker": "guest", "text": "Let's start with hooks, because once you understand them, the harness conversation makes a lot more sense. Hooks are basically lifecycle events you can plug shell commands into — pre-tool-use, post-tool-use, on-stop, that kind of thing." },
    { "speaker": "host", "text": "And the interesting move is that hooks run on the harness, not in the model. So they happen deterministically." },
    { "speaker": "guest", "text": "Right, and that distinction is doing a lot of work. The model can't decide to skip a hook. The harness fires it whether the model would have wanted it to or not." }
  ],
  "source_refs": [
    "https://example.com/article-1",
    "https://example.com/article-2",
    "wiki://pages/abc123"
  ],
  "published_at": "2026-05-04T18:30:00Z"
}
```

A real episode has 60–150 lines, not 4 — the example is truncated for readability.

## 5. Environment variables

Benwiki reads two env vars from `.env` (gitignored):

```
BENWIKI_PODCASTS_WEBHOOK_URL=https://benwiki-podcasts.vercel.app/api/episodes
BENWIKI_PODCASTS_TOKEN=<copy from benwiki-pods .env.local, key BENWIKI_WEBHOOK_TOKEN>
```

`BENWIKI_PODCASTS_TOKEN` must match the value of `BENWIKI_WEBHOOK_TOKEN` set both in the service's local `.env.local` and in the Vercel project environment variables. All three places need the same string.

For local-only testing, swap `BENWIKI_PODCASTS_WEBHOOK_URL` to `http://localhost:3000/api/episodes` and run `pnpm dev` in the service repo.

## 6. Pseudocode

```
result = run_ingest()
if result.new_items.empty(): return

overview_doc  = generate_overview(result.new_items)         # internal: title, description, source_refs, plus a long-form overview text
dialogue      = generate_dialogue(overview_doc.overview)    # internal: array of {speaker, text} via Claude/LLM

payload = {
  title:        overview_doc.title,
  description:  overview_doc.description,
  dialogue:     dialogue,
  source_refs:  overview_doc.source_refs,
  published_at: now_iso8601(),
}

for attempt in 1..3:
  resp = http.post(env.BENWIKI_PODCASTS_WEBHOOK_URL,
                   headers={Authorization: "Bearer " + env.BENWIKI_PODCASTS_TOKEN,
                            Content-Type: "application/json"},
                   body=json(payload))
  if resp.status == 202: break
  if resp.status >= 400 and resp.status < 500:
    log_error(resp); break          # don't retry client errors
  sleep(backoff(attempt))            # 1s, 4s, 16s
```

## 7. Smoke test

Useful any time you want to validate the round trip end-to-end (e.g. after changing the dialogue generator, rotating tokens, or onboarding a new environment):

1. Pick 2–3 real articles (or one substantive concept page) from Benwiki
2. Have Claude (or your LLM of choice) generate a `dialogue` array of 60–150 lines from the overview
3. Wrap it in the payload from §4 with a `title`, `description`, and `published_at`
4. POST it to the webhook with `curl`
5. Watch the row move `pending → generating → ready` in the Supabase console (end-to-end takes ~1–2 minutes: up to 60s waiting for the cron tick, plus ~30–60s of rendering)
6. Subscribe to the RSS feed in a podcast app and confirm the episode appears and plays

## 8. Out of scope

Benwiki does **not**:
- Track episode numbers (assigned downstream)
- Generate audio
- Render or host the RSS feed
- Retry beyond webhook delivery (the service handles ElevenLabs retries)
- Know about ElevenLabs at all

If any of those need to change, update the Benwiki Podcasts spec, not this one.
