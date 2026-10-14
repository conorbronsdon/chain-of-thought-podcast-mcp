import { afterAll, beforeAll, expect, it } from "vitest";
import { generateSql } from "../scripts/build-sql.ts";
import {
  getEpisode,
  getTranscriptExcerpt,
  searchEpisodes,
  searchTranscripts,
  ToolInputError,
} from "../src/tools.ts";
import { D1Shim, d1 } from "./helpers/d1-shim.ts";
import { files, manifest } from "./helpers/fixtures.ts";

let shim: D1Shim;
beforeAll(async () => {
  shim = new D1Shim();
  await shim.exec(await generateSql(manifest(), files, {
    now: "2026-01-02T00:00:00.000Z",
  }));
});
afterAll(() => shim.close());

it("searches transcripts with URLs, guest strings and filters", async () => {
  const result = await searchTranscripts(d1(shim), { query: "portable memory", limit: 8 });
  expect(result.results[0]).toMatchObject({
    episode: 77,
    speaker: "Kimberly Logan",
    url: files[2].transcript[1].url,
    guests: ["Kimberly Logan"],
  });
  expect(result.results[0].cite).toContain(result.results[0].url);
  const filtered = await searchTranscripts(d1(shim), {
    query: "multi-agent", limit: 8, episode: 38,
  });
  expect(filtered.results.every(row => row.episode === 38)).toBe(true);
  const some = await searchTranscripts(d1(shim), { query: "memory database", limit: 8 });
  expect(some.results.some(row => row.match === "some_terms")).toBe(true);
  const long = await searchTranscripts(d1(shim), { query: "many words", limit: 8 });
  expect(long.results[0].snippet.length).toBeLessThanOrEqual(601);
  const missing = await searchTranscripts(d1(shim), {
    query: "memory", limit: 8, episode: 999,
  });
  expect(missing.results).toHaveLength(0);
  expect(missing.note).toContain("Episode 999");
});

it("boosts matching episode metadata while keeping all-term hits before any-term hits", async () => {
  const first = structuredClone(files[0]);
  const second = structuredClone(files[2]);
  first.title = "A general conversation";
  first.summary = "A general conversation about software.";
  first.chapters = [];
  first.transcript = first.transcript.slice(0, 1);
  first.transcript[0].text = "Orbit engine builders discuss their work.";
  first.segmentCount = 1;
  second.title = "Orbit engine field guide";
  second.summary = "A guide to orbit engine systems.";
  second.chapters = [];
  second.transcript = second.transcript.slice(0, 1);
  second.transcript[0].text = "Orbit engine teams discuss their work.";
  second.segmentCount = 1;
  const local = new D1Shim();
  try {
    await local.exec(await generateSql(manifest([first, second]), [first, second], {
      now: "2026-01-02T00:00:00.000Z",
    }));
    const passageOnly = local.sqlite.prepare(`
      SELECT s.episode FROM segments_fts
      JOIN segments s ON s.id = segments_fts.rowid
      WHERE segments_fts MATCH 'orbit engine'
      ORDER BY bm25(segments_fts, 1.0, 0.25)
    `).all() as { episode: number }[];
    expect(passageOnly.map(row => row.episode)).toEqual([2, 77]);
    const results = (await searchTranscripts(d1(local), {
      query: "orbit engine", limit: 2,
    })).results;
    expect(results.map(row => row.episode)).toEqual([77, 2]);
    expect(results.every(row => row.match === "all_terms")).toBe(true);
  } finally {
    local.close();
  }

  const mixed = (await searchTranscripts(d1(shim), {
    query: "portable memory", limit: 8,
  })).results;
  expect(mixed.some(row => row.match === "all_terms")).toBe(true);
  expect(mixed.some(row => row.match === "some_terms")).toBe(true);
  const firstAny = mixed.findIndex(row => row.match === "some_terms");
  expect(mixed.slice(firstAny).every(row => row.match === "some_terms")).toBe(true);
  expect(new Set(mixed.map(row => row.url)).size).toBe(mixed.length);
});

it("collapses identical passages repeated across episodes", async () => {
  const repeated = files.map(file => {
    const copy = structuredClone(file);
    copy.transcript = copy.transcript.slice(0, 1);
    copy.transcript[0].text = "Portable memory for models and agents.";
    copy.segmentCount = 1;
    return copy;
  });
  const local = new D1Shim();
  try {
    await local.exec(await generateSql(manifest(repeated), repeated, {
      now: "2026-01-02T00:00:00.000Z",
    }));
    const results = (await searchTranscripts(d1(local), {
      query: "portable memory", limit: 8,
    })).results;
    expect(results).toHaveLength(1);
  } finally {
    local.close();
  }
});

it("searches episodes with folded diacritics and chapters", async () => {
  const results = (await searchEpisodes(d1(shim), { query: "Griciunas", limit: 8 })).results;
  expect(results[0]).toMatchObject({
    episode: 38,
    guests: ["Aurimas Griciūnas (SwirlAI)"],
    matching_chapters: [],
  });
  const chapters = (await searchEpisodes(d1(shim), { query: "multi-agent", limit: 8 }))
    .results.find(row => row.episode === 2)?.matching_chapters;
  expect(chapters).toEqual([{ time: "0:00", label: "Multi-agent teams" }]);
});

it("runs one FTS query for one search term in each search tool", async () => {
  const start = shim.preparedSql.length;
  await searchTranscripts(d1(shim), { query: "memory", limit: 8 });
  expect(shim.preparedSql.slice(start).filter(sql => sql.includes("segments_fts MATCH")))
    .toHaveLength(1);
  const next = shim.preparedSql.length;
  await searchEpisodes(d1(shim), { query: "memory", limit: 8 });
  expect(shim.preparedSql.slice(next).filter(sql => sql.includes("episodes_fts MATCH")))
    .toHaveLength(1);
});

it("returns episode metadata and bounded excerpt", async () => {
  const episode = await getEpisode(d1(shim), { slug: files[0].canonicalUrl });
  expect(episode).toMatchObject({
    episode: 2,
    duration: "37:39",
    guests: [{ name: "João Moura", company: "CrewAI" }],
  });
  const jsonUrl = `https://chainofthought.show/podcast/${files[0].slug}.json`;
  expect((await getEpisode(d1(shim), { slug: jsonUrl })).episode).toBe(2);
  await expect(getEpisode(d1(shim), { episode: 2, slug: files[2].slug }))
    .rejects.toThrow(/different episodes/u);

  const excerpt = await getTranscriptExcerpt(d1(shim), {
    episode: 77, at: "0:10", before: 1, after: 5,
  });
  expect(excerpt.anchor).toMatchObject({ segment_index: 1, time: "0:10" });
  expect(excerpt.segments).toHaveLength(3);
  expect(excerpt.segments[1].url).toBe(files[2].transcript[1].url);
  expect(excerpt.segments[2].text.length).toBeLessThanOrEqual(1500);
  expect(excerpt.has_more_before).toBe(false);
  expect(excerpt.has_more_after).toBe(false);

  const byIndex = await getTranscriptExcerpt(d1(shim), {
    episode: 77, at: "#t-2", before: 0, after: 0,
  });
  expect(byIndex.anchor.segment_index).toBe(2);
  expect(byIndex.has_more_before).toBe(true);
  expect(byIndex.has_more_after).toBe(false);
  await expect(getTranscriptExcerpt(d1(shim), {
    episode: 77, at: "99", before: 2, after: 5,
  })).rejects.toBeInstanceOf(ToolInputError);
  await expect(getEpisode(d1(shim), { episode: 999 }))
    .rejects.toThrow(/No episode 999/u);
});

it("resolves stored compound anchors and URLs without confusing them with indexes", async () => {
  const episode = structuredClone(files[2]);
  episode.transcript[1].url = `${episode.canonicalUrl}#t-0-1`;
  const local = new D1Shim();
  try {
    await local.exec(await generateSql(manifest([episode]), [episode], {
      now: "2026-01-02T00:00:00.000Z",
    }));
    for (const at of ["#t-0-1", "t-0-1", episode.transcript[1].url]) {
      const excerpt = await getTranscriptExcerpt(d1(local), {
        episode: 77, at, before: 0, after: 0,
      });
      expect(excerpt.anchor.segment_index).toBe(1);
      expect(excerpt.url).toBe(episode.transcript[1].url);
    }
    const byIndex = await getTranscriptExcerpt(d1(local), {
      episode: 77, at: "0", before: 0, after: 0,
    });
    expect(byIndex.anchor.segment_index).toBe(0);
    expect(byIndex.url).toBe(episode.transcript[0].url);
    await expect(getTranscriptExcerpt(d1(local), {
      episode: 77, at: files[0].transcript[1].url, before: 0, after: 0,
    })).rejects.toThrow(/does not belong to episode 77/u);
    await expect(getTranscriptExcerpt(d1(local), {
      episode: 77, at: "#t-99-1", before: 0, after: 0,
    })).rejects.toThrow(/No segment with anchor #t-99-1 in episode 77/u);
  } finally {
    local.close();
  }
});
