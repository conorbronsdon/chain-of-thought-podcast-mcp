import { expect, it } from "vitest";
import { generateSql } from "../scripts/build-sql.ts";
import { runRefresh } from "../src/refresh.ts";
import { SCHEMA } from "../src/schema.ts";
import { getTranscriptExcerpt, searchTranscripts } from "../src/tools.ts";
import type { EpisodeFile, Manifest } from "../src/types.ts";
import { D1Shim, d1 } from "./helpers/d1-shim.ts";
import { files, manifest, nullTimeEpisode } from "./helpers/fixtures.ts";

const now = new Date("2026-01-03T00:00:00.000Z");
const baseUrl = "https://chainofthought.show";

function fake(
  source: Manifest,
  episodes: EpisodeFile[],
  status: Record<number, number> = {},
  etag = '"v1"',
): typeof fetch {
  return (async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.endsWith("/corpus.json")) return Response.json(source);
    const file = episodes.find(episode => url.endsWith(`/${episode.slug}.json`));
    if (!file) return new Response("missing", { status: 404 });
    if (status[file.episode] === 304) return new Response(null, { status: 304 });
    if (status[file.episode]) return new Response("failed", { status: status[file.episode] });
    return Response.json(file, { headers: { etag } });
  }) as typeof fetch;
}

it("ingests one new episode per run, highest first, with searchable FTS", async () => {
  const shim = new D1Shim();
  await shim.exec(SCHEMA);
  const source = manifest();
  expect(await runRefresh({ db: d1(shim), fetch: fake(source, files), now, baseUrl }))
    .toMatchObject({ action: "ingested", episode: 77 });
  expect(shim.batchCount).toBeLessThan(15);
  expect(await runRefresh({ db: d1(shim), fetch: fake(source, files), now, baseUrl }))
    .toMatchObject({ action: "ingested", episode: 38 });
  const search = await searchTranscripts(d1(shim), { query: "portable memory", limit: 8 });
  expect(search.results[0].episode).toBe(77);
  shim.close();
});

it("reingests changed manifest and content, removing stale FTS tokens", async () => {
  const shim = new D1Shim();
  await shim.exec(await generateSql(manifest(), files, {
    now: "2026-01-01T00:00:00.000Z",
  }));
  const changed = structuredClone(files);
  changed[2].title = "Changed Walrus title";
  changed[2].transcript[0].text = "Novel quantum giraffe phrase.";
  const source = manifest(changed);
  expect(await runRefresh({ db: d1(shim), fetch: fake(source, changed), now, baseUrl }))
    .toMatchObject({ action: "ingested", episode: 77, reason: "manifest_changed" });
  expect((await searchTranscripts(d1(shim), { query: "quantum giraffe", limit: 8 })).results)
    .toHaveLength(1);
  expect((await searchTranscripts(d1(shim), { query: "between models", limit: 8 })).results)
    .toHaveLength(0);

  const content = structuredClone(changed);
  content[0].transcript[0].text = "Novel purple zebra phrase";
  expect(await runRefresh({
    db: d1(shim),
    fetch: fake(source, content),
    now: new Date("2026-01-04T00:00:00.000Z"),
    baseUrl,
  })).toMatchObject({ action: "ingested", episode: 2, reason: "content_changed" });
  shim.close();
});

it("handles 304 and rejects incomplete manifests for deletion", async () => {
  const shim = new D1Shim();
  await shim.exec(await generateSql(manifest(), files, {
    now: "2026-01-01T00:00:00.000Z",
    etags: { [files[0].slug]: '"v1"' },
  }));
  expect(await runRefresh({
    db: d1(shim), fetch: fake(manifest(), files, { 2: 304 }), now, baseUrl,
  })).toMatchObject({ action: "checked", episode: 2, reason: "not_modified" });
  const incomplete = manifest(files.slice(1));
  const result = await runRefresh({
    db: d1(shim),
    fetch: fake(incomplete, files),
    now: new Date("2026-01-04T00:00:00.000Z"),
    baseUrl,
  });
  expect(result.action).not.toBe("deleted");
  expect(shim.sqlite.prepare("SELECT count(*) AS n FROM episodes").get())
    .toMatchObject({ n: 3 });
  shim.close();
});

it("backs off failures and leaves episodes intact after manifest failure", async () => {
  const shim = new D1Shim();
  await shim.exec(SCHEMA);
  const source = manifest();
  expect(await runRefresh({
    db: d1(shim), fetch: fake(source, files, { 77: 500 }), now, baseUrl,
  })).toMatchObject({ action: "error", episode: 77 });
  expect(await runRefresh({
    db: d1(shim),
    fetch: fake(source, files),
    now: new Date("2026-01-03T01:00:00.000Z"),
    baseUrl,
  })).toMatchObject({ action: "ingested", episode: 38 });
  const bad = async () => new Response("error", { status: 500 });
  expect((await runRefresh({
    db: d1(shim), fetch: bad as typeof fetch, now, baseUrl,
  })).action).toBe("error");
  expect(shim.sqlite.prepare("SELECT count(*) AS n FROM episodes").get())
    .toMatchObject({ n: 1 });
  shim.close();
});

it("deletes one removed episode when 90 percent of the manifest remains", async () => {
  const copies = Array.from({ length: 10 }, (_, index) => {
    const file = structuredClone(files[0]);
    const number = index + 1;
    file.episode = number;
    file.slug = `${number}-copy`;
    file.canonicalUrl = `https://chainofthought.show/podcast/${file.slug}/`;
    file.transcript = file.transcript.map(segment => ({
      ...segment, url: `${file.canonicalUrl}#t-${segment.index}`,
    }));
    return file;
  });
  const shim = new D1Shim();
  await shim.exec(await generateSql(manifest(copies), copies, {
    now: "2026-01-01T00:00:00.000Z",
  }));
  const reduced = manifest(copies.slice(0, 9));
  expect(await runRefresh({ db: d1(shim), fetch: fake(reduced, copies), now, baseUrl }))
    .toMatchObject({ action: "deleted", episode: 10 });
  expect(shim.sqlite.prepare("SELECT count(*) AS n FROM episodes").get())
    .toMatchObject({ n: 9 });
  expect(shim.batchCount).toBeLessThan(15);
  shim.close();
});

it("rejects renumbered and malformed manifests without deleting stored episodes", async () => {
  const shim = new D1Shim();
  await shim.exec(await generateSql(manifest(), files, {
    now: "2026-01-01T00:00:00.000Z",
  }));
  const renamed = manifest();
  renamed.episodes = renamed.episodes.map(entry => ({ ...entry, episode: entry.episode + 1000 }));
  for (let i = 0; i < 3; i++) {
    const result = await runRefresh({ db: d1(shim), fetch: fake(renamed, files), now, baseUrl });
    expect(result.action).not.toBe("deleted");
  }
  expect(shim.sqlite.prepare("SELECT count(*) AS n FROM episodes").get())
    .toMatchObject({ n: 3 });
  const missingDate = manifest();
  delete (missingDate as unknown as Record<string, unknown>).dataUpdatedAt;
  expect(await runRefresh({ db: d1(shim), fetch: fake(missingDate, files), now, baseUrl }))
    .toMatchObject({ action: "error", reason: "manifest" });
  const duplicate = manifest();
  duplicate.episodes[1].episode = duplicate.episodes[0].episode;
  expect(await runRefresh({ db: d1(shim), fetch: fake(duplicate, files), now, baseUrl }))
    .toMatchObject({ action: "error", reason: "manifest" });
  const badSlug = manifest();
  badSlug.episodes[0].slug = "Bad Slug";
  expect(await runRefresh({ db: d1(shim), fetch: fake(badSlug, files), now, baseUrl }))
    .toMatchObject({ action: "error", reason: "manifest" });
  expect(shim.sqlite.prepare("SELECT count(*) AS n FROM episodes").get())
    .toMatchObject({ n: 3 });
  shim.close();
});

it("keeps null timestamps through build SQL, refresh, search and excerpts", async () => {
  const shim = new D1Shim();
  const original = nullTimeEpisode;
  await shim.exec(await generateSql(manifest([original]), [original], {
    now: "2026-01-01T00:00:00.000Z",
  }));
  const changed = structuredClone(nullTimeEpisode);
  changed.summary = "Updated with unknown timestamps";
  const result = await runRefresh({
    db: d1(shim), fetch: fake(manifest([changed]), [changed]), now, baseUrl,
  });
  expect(result).toMatchObject({ action: "ingested", episode: 2 });
  expect(shim.sqlite.prepare(`
    SELECT time, seconds FROM segments WHERE episode = 2 AND idx = 0
  `).get()).toEqual({ time: null, seconds: null });

  const search = await searchTranscripts(d1(shim), { query: "multi-agent", limit: 8 });
  expect(search.results[0]).toMatchObject({
    time: null, seconds: null, url: changed.transcript[0].url,
  });
  const byIndex = await getTranscriptExcerpt(d1(shim), {
    episode: 2, at: "#t-1", before: 0, after: 0,
  });
  expect(byIndex.anchor).toMatchObject({ segment_index: 1, time: null });
  expect(byIndex.segments[0]).toMatchObject({
    time: null, seconds: null, url: changed.transcript[1].url,
  });
  const byTime = await getTranscriptExcerpt(d1(shim), {
    episode: 2, at: "0:20", before: 0, after: 0,
  });
  expect(byTime.anchor).toMatchObject({ segment_index: 2, time: "0:20" });
  shim.close();
});

it("records a failed ingest batch so the episode backs off", async () => {
  const shim = new D1Shim();
  await shim.exec(SCHEMA);
  const source = manifest();
  const batch = shim.batch.bind(shim);
  let failIngest = true;
  shim.batch = async statements => {
    if (failIngest && statements.length > 4) throw new Error("D1 batch failed");
    return batch(statements);
  };
  expect(await runRefresh({ db: d1(shim), fetch: fake(source, files), now, baseUrl }))
    .toMatchObject({ action: "error", episode: 77, reason: "episode_failure" });
  const meta = Object.fromEntries((shim.sqlite.prepare("SELECT key, value FROM meta").all() as
    { key: string; value: string }[]).map(row => [row.key, row.value]));
  expect(JSON.parse(meta.refresh_failures)).toEqual({ 77: now.toISOString() });
  expect(meta.refresh_last_error).toBe("D1 batch failed");
  failIngest = false;
  expect(await runRefresh({
    db: d1(shim), fetch: fake(source, files), now: new Date("2026-01-03T01:00:00.000Z"), baseUrl,
  })).toMatchObject({ action: "ingested", episode: 38 });
  shim.close();
});
