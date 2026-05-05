-- Switch from ElevenLabs Studio API (whitelisted) to standard TTS pipeline.
-- Benwiki now generates the host/guest dialogue itself and posts it as a
-- JSON array; this service renders each line via /v1/text-to-speech and
-- concatenates the chunks.

alter table episodes drop column if exists overview;
alter table episodes drop column if exists elevenlabs_project_id;

alter table episodes add column dialogue jsonb not null default '[]'::jsonb;
