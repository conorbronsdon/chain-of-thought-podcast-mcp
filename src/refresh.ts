import {
  canonicalManifestEntry,
  contentHash,
  episodeJsonUrl,
  episodeRow,
  slugPattern,
  validateEpisodeFile,
} from "./ingest.ts";
import { EPISODE_COLUMNS } from "./schema.ts";
import type { EpisodeFile, Manifest, ManifestEntry } from "./types.ts";

type Stored = {
  episode: number;
  slug: string;
  manifest_entry: string;
  content_hash: string;
  etag: string | null;
  checked_at: string;
};

export type RefreshResult = {
  action: "none" | "ingested" | "deleted" | "checked" | "skipped" | "error";
  episode?: number;
  reason: string;
  detail?: string;
};

type Input = {
  db: D1Database;
  fetch: typeof fetch;
  now: Date;
  baseUrl: string;
};

const put = (db: D1Database, key: string, value: string) => db.prepare(`
  INSERT INTO meta(key, value) VALUES(?, ?)
  ON CONFLICT(key) DO UPDATE SET value = excluded.value
`).bind(key, value);

const errorText = (error: unknown) => error instanceof Error ? error.message : String(error);

// Processes at most one episode per run and records the outcome in meta.
export async function runRefresh(
  { db, fetch: fetcher, now, baseUrl }: Input,
): Promise<RefreshResult> {
  const iso = now.toISOString();
  let manifest: Manifest;

  const finish = async (result: RefreshResult, more: D1PreparedStatement[] = []) => {
    await db.batch([
      ...more,
      put(db, "refresh_last_run", iso),
      put(db, "refresh_last_result", JSON.stringify(result)),
    ]);
    return result;
  };

  const manifestError = async (error: unknown) => {
    const result: RefreshResult = {
      action: "error",
      reason: "manifest",
      detail: errorText(error),
    };
    return finish(result, [put(db, "refresh_last_error", result.detail ?? "")]);
  };

  try {
    const response = await fetcher(`${baseUrl}/corpus.json`, {
      headers: { "User-Agent": "cot-archive-mcp refresh" },
    });
    if (!response.ok) throw new Error(`Manifest HTTP ${response.status}`);

    const data: unknown = await response.json();
    if (!data || typeof data !== "object") throw new Error("Invalid manifest JSON");
    manifest = data as Manifest;
    if (
      manifest.schemaVersion !== 1
      || !Array.isArray(manifest.episodes)
      || !manifest.counts
      || manifest.counts.episodes !== manifest.episodes.length
      || typeof manifest.dataUpdatedAt !== "string"
      || !manifest.dataUpdatedAt.trim()
    ) {
      throw new Error("Invalid manifest schema or counts");
    }
    const numbers = new Set<number>();
    for (const entry of manifest.episodes) {
      if (!entry || !Number.isSafeInteger(entry.episode) || entry.episode < 1
        || numbers.has(entry.episode) || typeof entry.slug !== "string"
        || !slugPattern.test(entry.slug)) {
        throw new Error("Invalid or duplicate manifest episode entry");
      }
      numbers.add(entry.episode);
    }
  } catch (error) {
    return manifestError(error);
  }

  let stored: Stored[];
  let failures: Record<string, string>;
  try {
    stored = (await db.prepare(`
      SELECT episode, slug, manifest_entry, content_hash, etag, checked_at FROM episodes
    `).all<Stored>()).results;
    const failureRow = await db.prepare(`
      SELECT value FROM meta WHERE key = 'refresh_failures'
    `).first<{ value: string }>();
    failures = failureRow ? JSON.parse(failureRow.value) as Record<string, string> : {};
  } catch (error) {
    return manifestError(error);
  }

  const byNumber = new Map(manifest.episodes.map(entry => [entry.episode, entry]));
  const old = new Map(stored.map(row => [row.episode, row]));
  const eligible = (episode: number) => !failures[String(episode)]
    || now.getTime() - new Date(failures[String(episode)]).getTime() >= 6 * 3600 * 1000;
  const retained = stored.filter(row => byNumber.has(row.episode)).length;
  const removed = retained >= stored.length * 0.9
    ? stored.filter(row => !byNumber.has(row.episode) && eligible(row.episode))
      .sort((a, b) => a.episode - b.episode)[0]
    : undefined;
  const newest = (entries: ManifestEntry[]) => entries
    .filter(entry => eligible(entry.episode))
    .sort((a, b) => b.episode - a.episode)[0];
  const fresh = newest(manifest.episodes.filter(entry => !old.has(entry.episode)));
  const changed = newest(manifest.episodes.filter(entry =>
    old.has(entry.episode)
    && old.get(entry.episode)?.manifest_entry !== canonicalManifestEntry(entry)
  ));
  const round = stored.filter(row => byNumber.has(row.episode) && eligible(row.episode))
    .sort((a, b) => a.checked_at.localeCompare(b.checked_at) || a.episode - b.episode)[0];

  const pendingAfter = (handled: number) => {
    const removedCount = stored.filter(row =>
      row.episode !== handled && !byNumber.has(row.episode)
    ).length;
    const changedCount = manifest.episodes.filter(entry =>
      entry.episode !== handled
      && (!old.has(entry.episode)
        || old.get(entry.episode)?.manifest_entry !== canonicalManifestEntry(entry))
    ).length;
    return removedCount + changedCount === 0
      ? [put(db, "corpus_data_updated_at", manifest.dataUpdatedAt)]
      : [];
  };

  async function recordFailure(episode: number, error: unknown): Promise<RefreshResult> {
    failures[String(episode)] = iso;
    const result: RefreshResult = {
      action: "error",
      episode,
      reason: "episode_failure",
      detail: errorText(error),
    };
    return finish(result, [
      put(db, "refresh_failures", JSON.stringify(failures)),
      put(db, "refresh_last_error", result.detail ?? ""),
    ]);
  }

  if (removed) {
    const n = removed.episode;
    // Segment rowids occupy a fixed range for each episode.
    const lo = n * 100000;
    const hi = lo + 99999;
    // External-content FTS tables need delete records before their source rows disappear.
    const stmts = [
      db.prepare(`
        INSERT INTO segments_fts(segments_fts, rowid, text, speaker)
        SELECT 'delete', id, text, speaker FROM segments WHERE id BETWEEN ? AND ?
      `).bind(lo, hi),
      db.prepare("DELETE FROM segments WHERE id BETWEEN ? AND ?").bind(lo, hi),
      db.prepare(`
        INSERT INTO episodes_fts(episodes_fts, rowid, title, guests_text, chapters_text, summary)
        SELECT 'delete', episode, title, guests_text, chapters_text, summary
        FROM episodes WHERE episode = ?
      `).bind(n),
      db.prepare("DELETE FROM episodes WHERE episode = ?").bind(n),
      ...pendingAfter(n),
    ];
    try {
      return await finish({ action: "deleted", episode: n, reason: "removed_from_manifest" }, stmts);
    } catch (error) {
      return recordFailure(n, error);
    }
  }

  const entry = fresh ?? changed ?? (round ? byNumber.get(round.episode) : undefined);
  if (!entry) {
    return finish({
      action: stored.length || manifest.episodes.length ? "skipped" : "none",
      reason: stored.length || manifest.episodes.length ? "backoff" : "empty_archive",
    }, pendingAfter(-1));
  }

  const previous = old.get(entry.episode);
  const reason = fresh ? "new_episode" : changed ? "manifest_changed" : "round_robin";
  try {
    const headers: Record<string, string> = { "User-Agent": "cot-archive-mcp refresh" };
    if (reason === "round_robin" && previous?.etag) {
      headers["If-None-Match"] = previous.etag;
    }

    const response = await fetcher(episodeJsonUrl(entry, baseUrl), { headers });
    if (response.status === 304 && previous) {
      return finish({ action: "checked", episode: entry.episode, reason: "not_modified" }, [
        db.prepare("UPDATE episodes SET checked_at = ? WHERE episode = ?")
          .bind(iso, entry.episode),
        ...pendingAfter(entry.episode),
      ]);
    }
    if (!response.ok) throw new Error(`Episode HTTP ${response.status}`);

    const data: unknown = await response.json();
    validateEpisodeFile(data, entry);
    const file: EpisodeFile = data;
    const hash = await contentHash(file);
    const etag = response.headers.get("etag");
    if (
      previous
      && hash === previous.content_hash
      && previous.manifest_entry === canonicalManifestEntry(entry)
    ) {
      return finish({ action: "checked", episode: entry.episode, reason: "content_unchanged" }, [
        db.prepare("UPDATE episodes SET checked_at = ?, etag = ? WHERE episode = ?")
          .bind(iso, etag, entry.episode),
        ...pendingAfter(entry.episode),
      ]);
    }

    const n = entry.episode;
    // Segment rowids occupy a fixed range for each episode.
    const lo = n * 100000;
    const hi = lo + 99999;
    const row = episodeRow(file, entry, { contentHash: hash, etag, now: iso, baseUrl });
    const cols = EPISODE_COLUMNS.join(",");
    const marks = EPISODE_COLUMNS.map(() => "?").join(",");
    const updates = EPISODE_COLUMNS.filter(column => column !== "episode")
      .map(column => `${column}=excluded.${column}`).join(",");
    const payload = JSON.stringify(file.transcript.map(segment => [
      segment.index,
      segment.time,
      segment.seconds,
      segment.speaker,
      segment.text,
      segment.url,
    ]));

    // Delete old FTS entries before replacing source rows; rebuild entries in the same batch.
    const stmts = [
      db.prepare(`
        INSERT INTO segments_fts(segments_fts, rowid, text, speaker)
        SELECT 'delete', id, text, speaker FROM segments WHERE id BETWEEN ? AND ?
      `).bind(lo, hi),
      db.prepare("DELETE FROM segments WHERE id BETWEEN ? AND ?").bind(lo, hi),
      // json_each keeps the refresh to one D1 statement; json_extract maps JSON null to SQL NULL.
      db.prepare(`
        INSERT INTO segments(id, episode, idx, time, seconds, speaker, text, url)
        SELECT ? * 100000 + json_extract(value, '$[0]'), ?,
          json_extract(value, '$[0]'), json_extract(value, '$[1]'),
          json_extract(value, '$[2]'), json_extract(value, '$[3]'),
          json_extract(value, '$[4]'), json_extract(value, '$[5]')
        FROM json_each(?)
      `).bind(n, n, payload),
      db.prepare(`
        INSERT INTO segments_fts(rowid, text, speaker)
        SELECT id, text, speaker FROM segments WHERE id BETWEEN ? AND ?
      `).bind(lo, hi),
      db.prepare(`
        INSERT INTO episodes_fts(episodes_fts, rowid, title, guests_text, chapters_text, summary)
        SELECT 'delete', episode, title, guests_text, chapters_text, summary
        FROM episodes WHERE episode = ?
      `).bind(n),
      db.prepare(`
        INSERT INTO episodes(${cols}) VALUES(${marks})
        ON CONFLICT(episode) DO UPDATE SET ${updates}
      `).bind(...EPISODE_COLUMNS.map(column => row[column])),
      db.prepare(`
        INSERT INTO episodes_fts(rowid, title, guests_text, chapters_text, summary)
        SELECT episode, title, guests_text, chapters_text, summary
        FROM episodes WHERE episode = ?
      `).bind(n),
      put(db, "refresh_failures", JSON.stringify(Object.fromEntries(
        Object.entries(failures).filter(([key]) => key !== String(n)),
      ))),
      ...pendingAfter(n),
    ];
    return finish({
      action: "ingested",
      episode: n,
      reason: previous && reason === "round_robin" ? "content_changed" : reason,
    }, stmts);
  } catch (error) {
    return recordFailure(entry.episode, error);
  }
}
