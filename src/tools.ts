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

export const noWords = "The query has no searchable words. Use a specific topic, name or number instead of filler words.";
// Episode metadata is curated and spells names correctly when ASR passages do not.
// A passage is more likely to answer the query when its episode title, guests,
// chapters or summary also match.
const EPISODE_MATCH_WEIGHT = 0.4;
const FTS_CANDIDATES = 100;
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

  // Fetch extra candidates so repeated passages do not exhaust the result limit.
  const find = async (match: string): Promise<TranscriptRow[]> => {
    const sql = `
      WITH hits AS MATERIALIZED (
        SELECT rowid, bm25(segments_fts, 1.0, 0.25) AS score,
          snippet(segments_fts, 0, '', '', '…', 64) AS excerpt
        FROM segments_fts WHERE segments_fts MATCH ?
          ${input.episode === undefined ? "" : "AND rowid BETWEEN ? AND ?"}
        ORDER BY score LIMIT ?
      ), ep AS MATERIALIZED (
        SELECT rowid AS episode, bm25(episodes_fts, 8.0, 6.0, 3.0, 1.0) AS escore
        FROM episodes_fts WHERE episodes_fts MATCH ? ORDER BY escore LIMIT ?
      )
      SELECT s.id, s.episode, s.idx, s.time, s.seconds, s.speaker, s.url,
        CASE WHEN length(s.text) <= 600 THEN s.text
          ELSE hits.excerpt END AS snippet,
        hits.score
          + ${EPISODE_MATCH_WEIGHT} * coalesce(ep.escore, 0) AS score,
        e.title, e.canonical_url, e.guests_json, e.published_at
      FROM hits
      JOIN segments s ON s.id = hits.rowid
      JOIN episodes e ON e.episode = s.episode
      LEFT JOIN ep ON ep.episode = s.episode
      ORDER BY score LIMIT ?`;
    const args: (string | number)[] = [match];
    if (input.episode !== undefined) args.push(...range(input.episode));
    args.push(FTS_CANDIDATES, q.fill ?? q.all, FTS_CANDIDATES);
    args.push(Math.min(input.limit * 3, 60));
    return (await db.prepare(sql).bind(...args).all<TranscriptRow>()).results;
  };

  const all = await find(q.all);
  const seenUrls = new Set<string>();
  const seenPassages = new Set<string>();
  const rows: { r: TranscriptRow; match: "all_terms" | "some_terms" }[] = [];
  const add = (candidates: TranscriptRow[], match: "all_terms" | "some_terms") => {
    for (const row of candidates) {
      const key = fold(row.snippet).replace(/[^\p{L}\p{N}]/gu, "").slice(0, 80);
      if (seenUrls.has(row.url) || seenPassages.has(key)) continue;
      rows.push({ r: row, match });
      seenUrls.add(row.url);
      seenPassages.add(key);
      if (rows.length >= input.limit) break;
    }
  };
  add(all, "all_terms");
  // A single term has the same all and any query, so no fill query is needed.
  if (q.fill && all.length < input.limit && rows.length < input.limit) {
    add(await find(q.fill), "some_terms");
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
      WITH hits AS MATERIALIZED (
        SELECT rowid, bm25(episodes_fts, 8.0, 6.0, 3.0, 1.0) AS score
        FROM episodes_fts WHERE episodes_fts MATCH ? ORDER BY score LIMIT ?
      )
      SELECT e.*, hits.score FROM hits
      JOIN episodes e ON e.episode = hits.rowid
      ORDER BY hits.score LIMIT ?`;
    return (await db.prepare(sql).bind(match, FTS_CANDIDATES, input.limit)
      .all<EpisodeSearchRow>()).results;
  };

  const all = await find(q.all);
  const seen = new Set(all.map(row => row.episode));
  const rows = all.map(row => ({ r: row, match: "all_terms" }));
  // A single term has the same all and any query, so no fill query is needed.
  if (q.fill && rows.length < input.limit) {
    for (const row of await find(q.fill)) {
      if (seen.has(row.episode)) continue;
      rows.push({ r: row, match: "some_terms" });
      seen.add(row.episode);
      if (rows.length >= input.limit) break;
    }
  }

  const runs = q.contentTerms.map(fold);
  const matchesChapter = (label: unknown) => {
    if (typeof label !== "string") return false;
    const words = fold(label).split(/[^\p{L}\p{N}]+/u).filter(Boolean).join(" ");
    return runs.some(term => ` ${words} `.includes(` ${term} `));
  };
  return {
    query: input.query,
    results: rows.map(({ r, match }) => ({
      episode: r.episode,
      title: r.title,
      published_at: r.published_at,
      guests: guestStrings(guests(r.guests_json)),
      summary: cap(r.summary, 399),
      matching_chapters: chapters(r.chapters_json)
        .filter(chapter => matchesChapter(chapter?.label))
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
    let url: URL;
    try {
      url = new URL(value);
    } catch {
      throw new ToolInputError("The episode URL is invalid. Use a chainofthought.show episode URL or slug.");
    }
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

// Returns bounded context around an index, passage anchor or timestamp.
export async function getTranscriptExcerpt(
  db: D1Database,
  input: { episode: number; at?: string; before: number; after: number },
) {
  const parsed = parseAt(input.at);
  if (!parsed || (typeof parsed.value === "number" && !Number.isSafeInteger(parsed.value))) {
    throw new ToolInputError("Use a segment index, passage URL or #t- anchor, m:ss or h:mm:ss for at.");
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

  let anchor = parsed.kind === "anchor" ? 0 : parsed.value;
  const [lo, hi] = range(input.episode);
  if (parsed.kind === "anchor") {
    const hash = parsed.value.lastIndexOf("#");
    const base = parsed.value.startsWith("https://") ? parsed.value.slice(0, hash) : null;
    if (base !== null && base !== ep.canonical_url) {
      throw new ToolInputError(`The passage URL does not belong to episode ${input.episode}.`);
    }
    const fragment = hash >= 0 ? parsed.value.slice(hash) : `#${parsed.value}`;
    anchor = (await db.prepare(`
      SELECT idx FROM segments WHERE id BETWEEN ? AND ? AND url = ?
    `).bind(lo, hi, `${ep.canonical_url}${fragment}`).first<{ idx: number }>())?.idx ?? -1;
    if (anchor < 0) {
      throw new ToolInputError(`No segment with anchor ${fragment} in episode ${input.episode}.`);
    }
  } else if (parsed.kind === "seconds") {
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
