import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import {
  contentHash,
  episodeJsonUrl,
  episodeRow,
  segmentRow,
  validateEpisodeFile,
  type SqlValue,
} from "../src/ingest.ts";
import { EPISODE_COLUMNS, SCHEMA, SEGMENT_COLUMNS } from "../src/schema.ts";
import type { EpisodeFile, Manifest } from "../src/types.ts";

export type BuildOptions = {
  now: string;
  baseUrl?: string;
  only?: number[];
  etags?: Record<string, string>;
  statementLimitBytes?: number;
};

const enc = new TextEncoder();
const bytes = (text: string) => enc.encode(text).length;
const lit = (value: SqlValue): string => value === null
  ? "NULL"
  : typeof value === "number"
    ? String(value)
    : `'${value.replace(/\u0000/gu, "").replace(/'/gu, "''")}'`;

// Builds an idempotent import while keeping each segment statement below the D1 size limit.
export async function generateSql(
  manifest: Manifest,
  files: EpisodeFile[],
  options: BuildOptions,
): Promise<string> {
  if (
    manifest.schemaVersion !== 1
    || !Array.isArray(manifest.episodes)
    || manifest.counts?.episodes !== manifest.episodes.length
  ) {
    throw new Error("Invalid manifest or episode count");
  }
  const byNumber = new Map(files.map(file => [file.episode, file]));
  const selected = options.only
    ? manifest.episodes.filter(entry => options.only?.includes(entry.episode))
    : manifest.episodes;
  const segments = selected.reduce((count, entry) =>
    count + (byNumber.get(entry.episode)?.transcript.length ?? 0), 0
  );
  if (!options.only && segments !== manifest.counts.segments) {
    throw new Error(`Segment count mismatch: ${segments} != ${manifest.counts.segments}`);
  }
  const sql: string[] = [
    `-- Generated at ${options.now}; source dataUpdatedAt ${manifest.dataUpdatedAt}; `
      + `${selected.length} episodes; ${segments} segments.\n`
      + "-- Contains transcript text. Do not commit or redistribute.",
    SCHEMA,
  ];
  const limit = options.statementLimitBytes ?? 90000;

  for (const entry of selected) {
    const file = byNumber.get(entry.episode);
    if (!file) throw new Error(`Missing episode file ${entry.episode}`);
    validateEpisodeFile(file, entry);

    // Each episode owns a fixed rowid range, so reruns replace only its segments.
    const lo = entry.episode * 100000;
    sql.push(`DELETE FROM segments WHERE id BETWEEN ${lo} AND ${lo + 99999};`);
    const prefix = `INSERT INTO segments (${SEGMENT_COLUMNS.join(",")}) VALUES `;
    let body = "";
    for (const segment of file.transcript) {
      const row = segmentRow(entry.episode, segment);
      const tuple = `(${SEGMENT_COLUMNS.map(column => lit(row[column])).join(",")})`;
      if (body && bytes(prefix + body + "," + tuple + ";") >= limit) {
        sql.push(prefix + body + ";");
        body = "";
      }
      if (bytes(prefix + tuple + ";") >= limit) {
        throw new Error(
          `Segment ${entry.episode}:${segment.index} exceeds statement size limit`,
        );
      }
      body += `${body ? "," : ""}${tuple}`;
    }
    if (body) sql.push(prefix + body + ";");

    const row = episodeRow(file, entry, {
      contentHash: await contentHash(file),
      etag: options.etags?.[entry.slug] ?? null,
      now: options.now,
      baseUrl: options.baseUrl,
    });
    const columns = EPISODE_COLUMNS.join(",");
    const values = EPISODE_COLUMNS.map(column => lit(row[column])).join(",");
    const updates = EPISODE_COLUMNS.filter(column => column !== "episode")
      .map(column => `${column}=excluded.${column}`).join(",");
    sql.push(`INSERT INTO episodes (${columns}) VALUES (${values}) `
      + `ON CONFLICT(episode) DO UPDATE SET ${updates};`);
  }

  if (!options.only) {
    const nums = manifest.episodes.map(entry => entry.episode).join(",") || "-1";
    sql.push(
      `DELETE FROM segments WHERE episode NOT IN (${nums});`,
      `DELETE FROM episodes WHERE episode NOT IN (${nums});`,
    );
  }
  // External-content FTS tables need rebuilding after bulk row replacements.
  sql.push(
    "INSERT INTO segments_fts(segments_fts) VALUES('rebuild');",
    "INSERT INTO episodes_fts(episodes_fts) VALUES('rebuild');",
  );
  const meta = {
    corpus_data_updated_at: manifest.dataUpdatedAt,
    ingested_at: options.now,
    ingest_source: "build-sql",
    episode_count: String(selected.length),
    segment_count: String(segments),
  };
  for (const [key, value] of Object.entries(meta)) {
    sql.push(`INSERT INTO meta(key,value) VALUES(${lit(key)},${lit(value)}) `
      + "ON CONFLICT(key) DO UPDATE SET value=excluded.value;");
  }
  return sql.join("\n") + "\n";
}

const arg = (name: string): string | undefined => {
  const index = process.argv.indexOf(name);
  return index < 0 ? undefined : process.argv[index + 1];
};

async function main() {
  const out = arg("--out") ?? "dist/ingest.sql";
  const cache = arg("--cache-dir") ?? ".cache/corpus";
  const baseUrl = arg("--base-url") ?? "https://chainofthought.show";
  const offline = process.argv.includes("--offline");
  const only = arg("--only")?.split(",").map(Number);
  await mkdir(join(cache, "podcast"), { recursive: true });

  const get = async (url: string, file: string) => {
    if (offline) return readFile(file, "utf8");
    const response = await fetch(url, {
      headers: { "User-Agent": "cot-archive-mcp build-sql" },
    });
    if (!response.ok) throw new Error(`${url}: HTTP ${response.status}`);
    const text = await response.text();
    await writeFile(file, text);
    return { text, etag: response.headers.get("etag") };
  };

  const manifestResult = await get(`${baseUrl}/corpus.json`, join(cache, "corpus.json"));
  const manifest = JSON.parse(
    typeof manifestResult === "string" ? manifestResult : manifestResult.text,
  ) as Manifest;
  let etags: Record<string, string> = {};
  try {
    etags = JSON.parse(await readFile(join(cache, "etags.json"), "utf8")) as
      Record<string, string>;
  } catch { /* A fresh cache has no ETag file. */ }

  const selected = only
    ? manifest.episodes.filter(entry => only.includes(entry.episode))
    : manifest.episodes;
  if (only && (!only.every(Number.isInteger) || selected.length !== new Set(only).size)) {
    throw new Error("--only must list episode numbers present in the manifest");
  }
  const files: EpisodeFile[] = [];
  for (const entry of selected) {
    const result = await get(
      episodeJsonUrl(entry, baseUrl),
      join(cache, "podcast", `${entry.slug}.json`),
    );
    const file: unknown = JSON.parse(typeof result === "string" ? result : result.text);
    validateEpisodeFile(file, entry);
    files.push(file);
    if (typeof result !== "string" && result.etag) etags[entry.slug] = result.etag;
  }
  if (!offline) await writeFile(join(cache, "etags.json"), JSON.stringify(etags, null, 2));

  const sql = await generateSql(manifest, files, {
    now: new Date().toISOString(), baseUrl, only, etags,
  });
  await mkdir(dirname(out), { recursive: true });
  await writeFile(out, sql);
  const statements = sql.split(/;\n/u).length - 1;
  const largest = Math.max(...sql.split(/;\n/u).map(statement => bytes(statement + ";")));
  console.error(JSON.stringify({
    episodes: files.length,
    segments: files.reduce((count, file) => count + file.transcript.length, 0),
    statements,
    bytes: bytes(sql),
    largest_statement_bytes: largest,
  }));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(error => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
