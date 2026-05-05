create type episode_status as enum ('pending', 'generating', 'ready', 'failed');

create table episodes (
  id uuid primary key default gen_random_uuid(),
  episode_number int unique,
  title text not null,
  description text not null,
  overview text not null,
  source_refs jsonb,
  status episode_status not null default 'pending',
  elevenlabs_project_id text,
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

create or replace function set_updated_at() returns trigger as $$
begin
  new.updated_at = now();
  return new;
end;
$$ language plpgsql;

create trigger episodes_set_updated_at
  before update on episodes
  for each row execute function set_updated_at();

insert into storage.buckets (id, name, public)
values ('episode-audio', 'episode-audio', false)
on conflict (id) do nothing;
