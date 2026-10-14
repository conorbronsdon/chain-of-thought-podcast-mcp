import { EPISODE_COLUMNS, SEGMENT_COLUMNS } from "./schema.ts";
import type { EpisodeFile, ManifestEntry, Segment } from "./types.ts";

export type SqlValue = string | number | null;

export const slugPattern = /^[a-z0-9-]{1,200}$/u;

// Rejects malformed source data before either SQL builder or refresh writes it.
export function validateEpisodeFile(
  data: unknown,
  expected?: ManifestEntry,
): asserts data is EpisodeFile {
  if (!data || typeof data !== "object") throw new Error("Episode file must be an object");
  const f = data as Partial<EpisodeFile>;
  if (f.schemaVersion !== 1) throw new Error("Episode schemaVersion must be 1");
  if (typeof f.slug !== "string" || !slugPattern.test(f.slug)) {
    throw new Error("Invalid episode slug");
  }
  if (
    typeof f.canonicalUrl !== "string"
    || !f.canonicalUrl.startsWith("https://chainofthought.show/podcast/")
  ) {
    throw new Error("Invalid canonicalUrl");
  }
  if (!Number.isInteger(f.episode) || (f.episode ?? 0) < 1) {
    throw new Error("Invalid episode number");
  }
  if (
    expected
    && (f.episode !== expected.episode
      || f.slug !== expected.slug
      || f.canonicalUrl !== expected.canonicalUrl)
  ) {
    throw new Error(`Episode ${expected.episode} does not match manifest`);
  }
  if (!Array.isArray(f.transcript)) throw new Error("Transcript must be an array");
  if (!Array.isArray(f.guests) || !Array.isArray(f.chapters)) {
    throw new Error("Guests and chapters must be arrays");
  }
  if (typeof f.title !== "string" || typeof f.summary !== "string") {
    throw new Error(`Episode ${f.episode} has invalid title or summary`);
  }
  for (const [i, guest] of f.guests.entries()) {
    if (!guest || typeof guest.name !== "string" || !guest.name.trim()
      || (guest.company !== undefined && guest.company !== null
        && typeof guest.company !== "string")) {
      throw new Error(`Episode ${f.episode} guest ${i} has invalid fields`);
    }
  }
  for (const [i, chapter] of f.chapters.entries()) {
    if (!chapter || (chapter.time !== null && typeof chapter.time !== "string")
      || (chapter.seconds !== null && (typeof chapter.seconds !== "number"
        || !Number.isFinite(chapter.seconds)))
      || typeof chapter.label !== "string" || !chapter.label.trim()) {
      throw new Error(`Episode ${f.episode} chapter ${i} has invalid fields`);
    }
  }

  for (const [i, segment] of f.transcript.entries()) {
    if (segment.index !== i) {
      throw new Error(`Episode ${f.episode} segment index ${i} is not contiguous`);
    }
    const validTime = (segment.time === null && segment.seconds === null)
      || (typeof segment.time === "string"
        && typeof segment.seconds === "number"
        && Number.isFinite(segment.seconds));
    if (
      !validTime
      || typeof segment.speaker !== "string"
      || typeof segment.text !== "string"
      || typeof segment.url !== "string"
    ) {
      throw new Error(`Episode ${f.episode} segment ${i} has invalid fields`);
    }
    if (!segment.url.startsWith(f.canonicalUrl)) {
      throw new Error(`Episode ${f.episode} segment ${i} has a foreign URL`);
    }
  }
}

// Serializes manifest fields in a stable order for change detection.
export function canonicalManifestEntry(entry: ManifestEntry): string {
  return JSON.stringify([
    entry.slug, entry.episode, entry.season, entry.title, entry.publishedAt,
    entry.guests, entry.canonicalUrl, entry.json, entry.hasTranscript, entry.segmentCount,
  ]);
}

// Excludes usage metadata so only served episode content affects the hash.
export function canonicalEpisodeContent(file: EpisodeFile): string {
  return JSON.stringify([
    file.episode, file.slug, file.season, file.guid, file.title,
    file.canonicalUrl, file.publishedAt, file.durationSeconds,
    file.guests.map(guest => [guest.name, guest.company]),
    file.audioUrl, file.transistorUrl, file.youtubeUrl, file.summary,
    file.chapters.map(chapter => [chapter.time, chapter.seconds, chapter.label]),
    file.transcript.map(segment => [
      segment.index, segment.time, segment.seconds, segment.speaker,
      segment.text, segment.url,
    ]),
  ]);
}

// Hashes canonical content to skip writes when only HTTP metadata changes.
export async function contentHash(file: EpisodeFile): Promise<string> {
  const data = new TextEncoder().encode(canonicalEpisodeContent(file));
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", data));
  return Array.from(digest, byte => byte.toString(16).padStart(2, "0")).join("");
}

// Falls back to the predictable episode path when the manifest URL is unsuitable.
export function episodeJsonUrl(entry: ManifestEntry, baseUrl: string): string {
  if (!slugPattern.test(entry.slug)) throw new Error("Invalid episode slug");
  return entry.json.startsWith(`${baseUrl}/podcast/`) && entry.json.endsWith(".json")
    ? entry.json
    : `${baseUrl}/podcast/${entry.slug}.json`;
}

// Maps source metadata to the stable D1 column order.
export function episodeRow(
  file: EpisodeFile,
  entry: ManifestEntry,
  opts: { contentHash: string; etag: string | null; now: string; baseUrl?: string },
): Record<(typeof EPISODE_COLUMNS)[number], SqlValue> {
  return {
    episode: file.episode,
    slug: file.slug,
    season: file.season,
    guid: file.guid,
    title: file.title,
    published_at: file.publishedAt,
    duration_seconds: file.durationSeconds,
    canonical_url: file.canonicalUrl,
    json_url: episodeJsonUrl(entry, opts.baseUrl ?? "https://chainofthought.show"),
    audio_url: file.audioUrl,
    transistor_url: file.transistorUrl,
    youtube_url: file.youtubeUrl,
    summary: file.summary,
    guests_json: JSON.stringify(file.guests),
    guests_text: file.guests.map(guest =>
      [guest.name, guest.company].filter(Boolean).join(", ")
    ).join("; "),
    chapters_json: JSON.stringify(file.chapters),
    chapters_text: file.chapters.map(chapter => chapter.label).join("\n"),
    segment_count: file.transcript.length,
    manifest_entry: canonicalManifestEntry(entry),
    content_hash: opts.contentHash,
    etag: opts.etag,
    ingested_at: opts.now,
    checked_at: opts.now,
  };
}

// Gives each segment a deterministic rowid within its episode's range.
export function segmentRow(
  episode: number,
  segment: Segment,
): Record<(typeof SEGMENT_COLUMNS)[number], SqlValue> {
  return {
    id: episode * 100000 + segment.index,
    episode,
    idx: segment.index,
    time: segment.time,
    seconds: segment.seconds,
    speaker: segment.speaker,
    text: segment.text,
    url: segment.url,
  };
}
