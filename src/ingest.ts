import { EPISODE_COLUMNS, SEGMENT_COLUMNS } from "./schema.ts";
import type { EpisodeFile, ManifestEntry, Segment } from "./types.ts";
export type SqlValue = string | number | null;
const slugPattern = /^[a-z0-9-]{1,200}$/u;
export function validateEpisodeFile(data: unknown, expected?: ManifestEntry): asserts data is EpisodeFile {
  if (!data || typeof data !== "object") throw new Error("Episode file must be an object");
  const f = data as Partial<EpisodeFile>;
  if (f.schemaVersion !== 1) throw new Error("Episode schemaVersion must be 1");
  if (typeof f.slug !== "string" || !slugPattern.test(f.slug)) throw new Error("Invalid episode slug");
  if (typeof f.canonicalUrl !== "string" || !f.canonicalUrl.startsWith("https://chainofthought.show/podcast/")) throw new Error("Invalid canonicalUrl");
  if (!Number.isInteger(f.episode) || (f.episode ?? 0) < 1) throw new Error("Invalid episode number");
  if (expected && (f.episode !== expected.episode || f.slug !== expected.slug || f.canonicalUrl !== expected.canonicalUrl)) throw new Error(`Episode ${expected.episode} does not match manifest`);
  if (!Array.isArray(f.transcript)) throw new Error("Transcript must be an array");
  if (!Array.isArray(f.guests) || !Array.isArray(f.chapters)) throw new Error("Guests and chapters must be arrays");
  for (const [i, s] of f.transcript.entries()) {
    if (s.index !== i) throw new Error(`Episode ${f.episode} segment index ${i} is not contiguous`);
    if (typeof s.time !== "string" || typeof s.speaker !== "string" || typeof s.text !== "string" || typeof s.url !== "string" || !Number.isFinite(s.seconds)) throw new Error(`Episode ${f.episode} segment ${i} has invalid fields`);
    if (!s.url.startsWith(f.canonicalUrl)) throw new Error(`Episode ${f.episode} segment ${i} has a foreign URL`);
  }
}
export function canonicalManifestEntry(e: ManifestEntry): string {
  return JSON.stringify([e.slug,e.episode,e.season,e.title,e.publishedAt,e.guests,e.canonicalUrl,e.json,e.hasTranscript,e.segmentCount]);
}
export function canonicalEpisodeContent(f: EpisodeFile): string {
  return JSON.stringify([f.episode,f.slug,f.season,f.guid,f.title,f.canonicalUrl,f.publishedAt,f.durationSeconds,
    f.guests.map(g => [g.name,g.company]),f.audioUrl,f.transistorUrl,f.youtubeUrl,f.summary,
    f.chapters.map(c => [c.time,c.seconds,c.label]),f.transcript.map(s => [s.index,s.time,s.seconds,s.speaker,s.text,s.url])]);
}
export async function contentHash(f: EpisodeFile): Promise<string> {
  const data = new TextEncoder().encode(canonicalEpisodeContent(f));
  return Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", data)), x => x.toString(16).padStart(2,"0")).join("");
}
export function episodeJsonUrl(entry: ManifestEntry, baseUrl: string): string {
  if (!slugPattern.test(entry.slug)) throw new Error("Invalid episode slug");
  return entry.json.startsWith(`${baseUrl}/podcast/`) && entry.json.endsWith(".json") ? entry.json : `${baseUrl}/podcast/${entry.slug}.json`;
}
export function episodeRow(f: EpisodeFile, e: ManifestEntry, opts: { contentHash: string; etag: string | null; now: string; baseUrl?: string }): Record<(typeof EPISODE_COLUMNS)[number], SqlValue> {
  return {
    episode:f.episode, slug:f.slug, season:f.season, guid:f.guid, title:f.title, published_at:f.publishedAt,
    duration_seconds:f.durationSeconds, canonical_url:f.canonicalUrl, json_url:episodeJsonUrl(e,opts.baseUrl ?? "https://chainofthought.show"),
    audio_url:f.audioUrl, transistor_url:f.transistorUrl, youtube_url:f.youtubeUrl, summary:f.summary,
    guests_json:JSON.stringify(f.guests), guests_text:f.guests.map(g => [g.name,g.company].filter(Boolean).join(", ")).join("; "),
    chapters_json:JSON.stringify(f.chapters), chapters_text:f.chapters.map(c => c.label).join("\n"),
    segment_count:f.transcript.length, manifest_entry:canonicalManifestEntry(e), content_hash:opts.contentHash,
    etag:opts.etag, ingested_at:opts.now, checked_at:opts.now
  };
}
export function segmentRow(episode: number, s: Segment): Record<(typeof SEGMENT_COLUMNS)[number], SqlValue> {
  return { id:episode*100000+s.index, episode, idx:s.index, time:s.time, seconds:s.seconds, speaker:s.speaker, text:s.text, url:s.url };
}
