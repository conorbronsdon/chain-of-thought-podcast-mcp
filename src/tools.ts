import { buildFtsQuery } from "./fts.ts";
import { cap, cite, duration, fold, guestStrings, parseAt } from "./format.ts";
import type { Chapter, Guest } from "./types.ts";

export class ToolInputError extends Error {}

type SearchInput = { query: string; limit: number; episode?: number };

type EpisodeRow = {
  episode: number;
  season: number | null;
  slug: string;
  title: string;
  published_at: string | null;
  duration_seconds: number | null;
  canonical_url: string;
  youtube_url: string | null;
  audio_url: string | null;
  transistor_url: string | null;
  summary: string;
  guests_json: string;
  chapters_json: string;
  segment_count: number;
};

type TranscriptRow = {
  id: number;
  episode: number;
  idx: number;
  time: string | null;
  seconds: number | null;
  speaker: string;
  url: string;
  snippet: string;
  title: string;
  canonical_url: string;
  guests_json: string;
  published_at: string | null;
};

type EpisodeSearchRow = EpisodeRow & { score: number };

type SegmentRow = {
  idx: number;
  time: string | null;
  seconds: number | null;
  speaker: string;
  text: string;
  url: string;
};

const noWords = "The query has no searchable words. Use plain words, names or numbers.";
const guests = (json: string): Guest[] => JSON.parse(json) as Guest[];
const chapters = (json: string): Chapter[] => JSON.parse(json) as Chapter[];
const range = (episode: number): [number, number] => [
  episode * 100000,
  episode * 100000 + 99999,
];

// Searches passages with all terms first, then fills remaining slots with any-term matches.
export async function searchTranscripts(db: D1Database, input: SearchInput) {
  const q = buildFtsQuery(input.query);
  if (!q) throw new ToolInputError(noWords);

  // FTS supplies relevance scores; snippet is used only for long source segments.
  const find = async (match: string): Promise<TranscriptRow[]> => {
    const sql = `
      SELECT s.id, s.episode, s.idx, s.time, s.seconds, s.speaker, s.url,
        CASE WHEN length(s.text) <= 600 THEN s.text
          ELSE snippet(segments_fts, 0, '', '', '…', 64) END AS snippet,
        bm25(segments_fts, 1.0, 0.25) AS score,
        e.title, e.canonical_url, e.guests_json, e.published_at
      FROM segments_fts
      JOIN segments s ON s.id = segments_fts.rowid
      JOIN episodes e ON e.episode = s.episode
      WHERE segments_fts MATCH ?
        ${input.episode === undefined ? "" : "AND segments_fts.rowid BETWEEN ? AND ?"}
      ORDER BY score LIMIT ?`;
    const args: (string | number)[] = [match];
    if (input.episode !== undefined) args.push(...range(input.episode));
    args.push(input.limit);
    return (await db.prepare(sql).bind(...args).all<TranscriptRow>()).results;
  };

  const all = await find(q.all);
  const seen = new Set(all.map(row => row.id));
  const rows = all.map(row => ({ r: row, match: "all_terms" }));
  // A single term has the same all and any query, so no fill query is needed.
  if (q.terms.length > 1 && rows.length < input.limit) {
    for (const row of await find(q.any)) {
      if (seen.has(row.id)) continue;
      rows.push({ r: row, match: "some_terms" });
      seen.add(row.id);
      if (rows.length >= input.limit) break;
    }
  }

  const results = rows.map(({ r, match }) => ({
    episode: r.episode,
    episode_title: r.title,
    guests: guestStrings(guests(r.guests_json)),
    published_at: r.published_at,
    speaker: r.speaker,
    time: r.time,
    seconds: r.seconds,
    segment_index: r.idx,
    snippet: cap(r.snippet, 600),
    match,
    url: r.url,
    episode_url: r.canonical_url,
    cite: cite(r.url),
  }));
  let note = "Transcripts are machine-generated (ASR); verify quotations against the "
    + "recording. Cite each result's url.";
  if (
    input.episode !== undefined
    && !(await db.prepare("SELECT episode FROM episodes WHERE episode = ?")
      .bind(input.episode).first())
  ) {
    note += ` Episode ${input.episode} is not in the archive.`;
  }
  return { query: input.query, results, note };
}

// Ranks episode metadata and chapter matches by the same all-then-any approach.
export async function searchEpisodes(db: D1Database, input: SearchInput) {
  const q = buildFtsQuery(input.query);
  if (!q) throw new ToolInputError(noWords);

  // Column weights favor titles and guest names over summaries.
  const find = async (match: string): Promise<EpisodeSearchRow[]> => {
    const sql = `
      SELECT e.*, bm25(episodes_fts, 8.0, 6.0, 3.0, 1.0) AS score
      FROM episodes_fts JOIN episodes e ON e.episode = episodes_fts.rowid
      WHERE episodes_fts MATCH ? ORDER BY score LIMIT ?`;
    return (await db.prepare(sql).bind(match, input.limit).all<EpisodeSearchRow>()).results;
  };

  const all = await find(q.all);
  const seen = new Set(all.map(row => row.episode));
  const rows = all.map(row => ({ r: row, match: "all_terms" }));
  // A single term has the same all and any query, so no fill query is needed.
  if (q.terms.length > 1 && rows.length < input.limit) {
    for (const row of await find(q.any)) {
      if (seen.has(row.episode)) continue;
      rows.push({ r: row, match: "some_terms" });
      seen.add(row.episode);
      if (rows.length >= input.limit) break;
    }
  }

  const runs = (input.query.normalize("NFKC").match(/[\p{L}\p{N}\p{Co}]+/gu) ?? [])
    .map(fold);
  return {
    query: input.query,
    results: rows.map(({ r, match }) => ({
      episode: r.episode,
      title: r.title,
      published_at: r.published_at,
      guests: guestStrings(guests(r.guests_json)),
      summary: cap(r.summary, 399),
      matching_chapters: chapters(r.chapters_json)
        .filter(chapter => runs.some(term => fold(chapter.label).includes(term)))
        .slice(0, 3)
        .map(chapter => ({ time: chapter.time, label: chapter.label })),
      match,
      url: r.canonical_url,
      cite: cite(r.canonical_url),
    })),
    note: "Cite each result's url.",
  };
}

// Accepts a slug or an episode page URL while rejecting other hosts and paths.
export function normalizeSlug(value: string): string {
  let slug = value;
  if (value.startsWith("https://")) {
    const url = new URL(value);
    if (url.hostname !== "chainofthought.show" || !url.pathname.startsWith("/podcast/")) {
      throw new ToolInputError("Use a chainofthought.show episode URL or slug.");
    }
    slug = url.pathname.split("/").filter(Boolean).at(-1) ?? "";
  }
  slug = slug.replace(/\.json$/u, "");
  if (!/^[a-z0-9-]{1,200}$/u.test(slug)) {
    throw new ToolInputError("The episode slug is invalid.");
  }
  return slug;
}

// Returns metadata without loading or exposing a whole transcript.
export async function getEpisode(
  db: D1Database,
  input: { episode?: number; slug?: string },
) {
  if (input.episode === undefined && input.slug === undefined) {
    throw new ToolInputError("Provide an episode number or slug.");
  }
  const slug = input.slug === undefined ? undefined : normalizeSlug(input.slug);
  const numberRow = input.episode === undefined ? null
    : await db.prepare("SELECT * FROM episodes WHERE episode = ?")
      .bind(input.episode).first<EpisodeRow>();
  const slugRow = slug === undefined ? null
    : await db.prepare("SELECT * FROM episodes WHERE slug = ?")
      .bind(slug).first<EpisodeRow>();
  if (
    input.episode !== undefined
    && slug !== undefined
    && numberRow?.episode !== slugRow?.episode
  ) {
    throw new ToolInputError("The episode number and slug refer to different episodes.");
  }

  const r = numberRow ?? slugRow;
  if (!r) {
    if (input.episode !== undefined) {
      const max = await db.prepare("SELECT max(episode) AS n FROM episodes")
        .first<{ n: number | null }>();
      throw new ToolInputError(
        `No episode ${input.episode}. Episodes run from 1 to ${max?.n ?? 0}.`,
      );
    }
    throw new ToolInputError(`No episode with slug ${slug}.`);
  }

  return {
    episode: r.episode,
    season: r.season,
    slug: r.slug,
    title: r.title,
    published_at: r.published_at,
    duration: duration(r.duration_seconds),
    duration_seconds: r.duration_seconds,
    guests: guests(r.guests_json),
    summary: r.summary,
    chapters: chapters(r.chapters_json),
    links: {
      episode_page: r.canonical_url,
      ...(r.youtube_url ? { youtube: r.youtube_url } : {}),
      ...(r.audio_url ? { audio: r.audio_url } : {}),
      ...(r.transistor_url ? { transistor: r.transistor_url } : {}),
    },
    segment_count: r.segment_count,
    url: r.canonical_url,
    cite: cite(r.canonical_url),
    note: "The transcript is on the episode page. Use search_transcripts or get_transcript_excerpt for passages.",
  };
}

// Returns bounded context around an index or the last timestamp at or before a time.
export async function getTranscriptExcerpt(
  db: D1Database,
  input: { episode: number; at?: string; before: number; after: number },
) {
  const parsed = parseAt(input.at);
  if (!parsed || !Number.isSafeInteger(parsed.value)) {
    throw new ToolInputError("Use a segment index, #t-N, t-N, m:ss or h:mm:ss for at.");
  }
  const ep = await db.prepare(`
    SELECT episode, title, canonical_url, segment_count
    FROM episodes WHERE episode = ?
  `).bind(input.episode).first<{
    episode: number;
    title: string;
    canonical_url: string;
    segment_count: number;
  }>();
  if (!ep) throw new ToolInputError(`No episode ${input.episode}.`);
  if (ep.segment_count === 0) {
    throw new ToolInputError(`Episode ${input.episode} has no transcript segments.`);
  }

  let anchor = parsed.value;
  const [lo, hi] = range(input.episode);
  if (parsed.kind === "seconds") {
    anchor = (await db.prepare(`
      SELECT idx FROM segments
      WHERE id BETWEEN ? AND ? AND seconds IS NOT NULL AND seconds <= ?
      ORDER BY id DESC LIMIT 1
    `).bind(lo, hi, parsed.value).first<{ idx: number }>())?.idx ?? 0;
  }
  if (anchor >= ep.segment_count) {
    throw new ToolInputError(
      `Episode ${input.episode} has ${ep.segment_count} segments (0 to ${ep.segment_count - 1}).`,
    );
  }

  const first = Math.max(0, anchor - input.before);
  const last = Math.min(ep.segment_count - 1, anchor + input.after);
  // The rowid range retrieves adjacent segments without scanning other episodes.
  const rows = (await db.prepare(`
    SELECT idx, time, seconds, speaker, text, url FROM segments
    WHERE id BETWEEN ? AND ? ORDER BY id
  `).bind(lo + first, lo + last).all<SegmentRow>()).results;
  const anchorRow = rows.find(row => row.idx === anchor);
  if (!anchorRow) throw new Error("Anchor segment missing");

  return {
    episode: ep.episode,
    episode_title: ep.title,
    episode_url: ep.canonical_url,
    anchor: { requested: input.at ?? "0", segment_index: anchor, time: anchorRow.time },
    segments: rows.map(row => ({
      segment_index: row.idx,
      time: row.time,
      seconds: row.seconds,
      speaker: row.speaker,
      text: cap(row.text, 1499),
      url: row.url,
      ...(row.text.length > 1499 ? { truncated: true } : {}),
    })),
    segment_count: ep.segment_count,
    has_more_before: first > 0,
    has_more_after: last < ep.segment_count - 1,
    url: anchorRow.url,
    cite: cite(anchorRow.url),
    note: "Transcripts are machine-generated (ASR); verify exact quotations against the recording.",
  };
}
