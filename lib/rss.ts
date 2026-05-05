import type { EpisodeRow } from "./supabase";

function escapeXml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function rfc822(iso: string): string {
  return new Date(iso).toUTCString();
}

function formatDuration(seconds: number): string {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  const pad = (n: number) => n.toString().padStart(2, "0");
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
}

export type FeedConfig = {
  title: string;
  author: string;
  ownerEmail: string;
  description: string;
  baseUrl: string;
  coverUrl: string;
  language: string;
  category: string;
};

export function feedConfigFromEnv(): FeedConfig {
  const required = [
    "PODCAST_TITLE",
    "PODCAST_AUTHOR",
    "PODCAST_OWNER_EMAIL",
    "PODCAST_DESCRIPTION",
    "PODCAST_BASE_URL",
    "PODCAST_COVER_URL",
    "PODCAST_LANGUAGE",
    "PODCAST_CATEGORY",
  ] as const;
  for (const k of required) {
    if (!process.env[k]) throw new Error(`${k} must be set`);
  }
  return {
    title: process.env.PODCAST_TITLE!,
    author: process.env.PODCAST_AUTHOR!,
    ownerEmail: process.env.PODCAST_OWNER_EMAIL!,
    description: process.env.PODCAST_DESCRIPTION!,
    baseUrl: process.env.PODCAST_BASE_URL!,
    coverUrl: process.env.PODCAST_COVER_URL!,
    language: process.env.PODCAST_LANGUAGE!,
    category: process.env.PODCAST_CATEGORY!,
  };
}

export function buildRss(cfg: FeedConfig, episodes: EpisodeRow[]): string {
  const items = episodes
    .map((ep) => {
      if (
        ep.episode_number == null ||
        ep.audio_size_bytes == null ||
        ep.audio_duration_seconds == null
      ) {
        return "";
      }
      const audioUrl = `${cfg.baseUrl}/audio/${ep.id}.mp3`;
      return `    <item>
      <title>${escapeXml(ep.title)}</title>
      <description>${escapeXml(ep.description)}</description>
      <pubDate>${rfc822(ep.published_at)}</pubDate>
      <guid isPermaLink="false">${escapeXml(ep.id)}</guid>
      <enclosure url="${escapeXml(audioUrl)}" length="${ep.audio_size_bytes}" type="audio/mpeg"/>
      <itunes:duration>${formatDuration(ep.audio_duration_seconds)}</itunes:duration>
      <itunes:episode>${ep.episode_number}</itunes:episode>
      <itunes:explicit>false</itunes:explicit>
    </item>`;
    })
    .filter(Boolean)
    .join("\n");

  return `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0"
     xmlns:itunes="http://www.itunes.com/dtds/podcast-1.0.dtd"
     xmlns:content="http://purl.org/rss/1.0/modules/content/">
  <channel>
    <title>${escapeXml(cfg.title)}</title>
    <link>${escapeXml(cfg.baseUrl)}</link>
    <language>${escapeXml(cfg.language)}</language>
    <description>${escapeXml(cfg.description)}</description>
    <itunes:author>${escapeXml(cfg.author)}</itunes:author>
    <itunes:summary>${escapeXml(cfg.description)}</itunes:summary>
    <itunes:owner>
      <itunes:name>${escapeXml(cfg.author)}</itunes:name>
      <itunes:email>${escapeXml(cfg.ownerEmail)}</itunes:email>
    </itunes:owner>
    <itunes:image href="${escapeXml(cfg.coverUrl)}"/>
    <itunes:category text="${escapeXml(cfg.category)}"/>
    <itunes:explicit>false</itunes:explicit>
${items}
  </channel>
</rss>`;
}
