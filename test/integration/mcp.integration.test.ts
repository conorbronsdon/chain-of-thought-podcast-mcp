import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  Client as ModernClient,
  StreamableHTTPClientTransport as ModernTransport,
} from "@modelcontextprotocol/client";
import { Client as LegacyClient } from "@modelcontextprotocol/sdk/client/index.js";
import {
  StreamableHTTPClientTransport as LegacyTransport,
} from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { EpisodeFile, Manifest } from "../../src/types.ts";

const url = process.env.MCP_URL ?? "http://127.0.0.1:8787/mcp";
const episodes = new Map<number, EpisodeFile>();
let modern: ModernClient;
let legacy: LegacyClient;
let ep77: EpisodeFile;
let ep38: EpisodeFile;
let ep2: EpisodeFile;

async function call(name: string, args: Record<string, unknown>) {
  const response = await modern.callTool({ name, arguments: args });
  const content = response.content.find(item => item.type === "text");
  const text = content?.type === "text" ? content.text : "";
  return {
    error: response.isError === true,
    text,
    value: response.isError === true || !text
      ? null
      : JSON.parse(text) as Record<string, unknown>,
  };
}

function assertSearchCites(value: Record<string, unknown> | null) {
  const results = value?.results as {
    episode: number;
    segment_index: number;
    url: string;
    cite: string;
  }[];
  expect(Array.isArray(results)).toBe(true);
  for (const result of results) {
    expect(result.cite).toBe(`Chain of Thought, chainofthought.show — ${result.url}`);
    expect(result.url.startsWith(`${episodes.get(result.episode)!.canonicalUrl}#t-`)).toBe(true);
  }
}

function assertEpisodeSearchCites(value: Record<string, unknown> | null) {
  const results = value?.results as { episode: number; url: string; cite: string }[];
  expect(Array.isArray(results)).toBe(true);
  for (const result of results) {
    expect(result.cite).toBe(`Chain of Thought, chainofthought.show — ${result.url}`);
    expect(result.url).toBe(episodes.get(result.episode)!.canonicalUrl);
  }
}

beforeAll(async () => {
  const manifest = JSON.parse(await readFile(".cache/corpus/corpus.json", "utf8")) as Manifest;
  const file = async (episode: number) => {
    const slug = manifest.episodes.find(entry => entry.episode === episode)?.slug;
    return JSON.parse(await readFile(join(".cache/corpus/podcast", `${slug}.json`), "utf8")) as
      EpisodeFile;
  };
  [ep77, ep38, ep2] = await Promise.all([file(77), file(38), file(2)]);
  for (const episode of [ep77, ep38, ep2]) {
    episodes.set(episode.episode, episode);
  }
  modern = new ModernClient(
    { name: "cot-integration-modern", version: "1.0.0" },
    { versionNegotiation: { mode: "auto" } },
  );
  await modern.connect(new ModernTransport(new URL(url)));
  legacy = new LegacyClient({ name: "cot-integration-legacy", version: "1.0.0" });
  await legacy.connect(new LegacyTransport(new URL(url)));
});

afterAll(async () => {
  await modern?.close();
  await legacy?.close();
});

describe("live MCP fixture", () => {
  it("lists four annotated tools on both clients", async () => {
    const tools = (await modern.listTools()).tools;
    expect(tools.map(tool => tool.name).sort()).toEqual([
      "get_episode", "get_transcript_excerpt", "search_episodes", "search_transcripts",
    ]);
    for (const tool of tools) {
      expect(tool.annotations).toMatchObject({
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      });
    }
    expect((await legacy.listTools()).tools).toHaveLength(4);
  });

  it("finds real transcript passages and filters by episode", async () => {
    const target = ep77.transcript[0];
    const query = (target.text.match(/[\p{L}\p{N}\p{Co}]+/gu) ?? [])
      .slice(0, 6).join("-");
    const search = await call("search_transcripts", { query });
    expect(search.error).toBe(false);
    assertSearchCites(search.value);
    expect((search.value?.results as { url: string }[])[0].url).toBe(target.url);
    const hit = (search.value?.results as {
      episode: number; segment_index: number; url: string;
    }[])[0];
    const byUrl = await call("get_transcript_excerpt", { episode: hit.episode, at: hit.url });
    expect(byUrl.error).toBe(false);
    expect(byUrl.value?.anchor).toMatchObject({ segment_index: hit.segment_index });

    const episodeTwoQuery = (ep2.transcript[0].text.match(/[\p{L}\p{N}\p{Co}]+/gu)
      ?? []).slice(0, 5).join("-");
    const filtered = await call("search_transcripts", {
      query: episodeTwoQuery, episode: 2,
    });
    assertSearchCites(filtered.value);
    const results = filtered.value?.results as { episode: number }[];
    expect(results.length).toBeGreaterThan(0);
    expect(results.every(result => result.episode === 2)).toBe(true);

    const old = await legacy.callTool({
      name: "search_transcripts",
      arguments: { query: episodeTwoQuery, episode: 2 },
    });
    expect(old.isError).not.toBe(true);
  });

  it("returns real guests, chapters, links and excerpt", async () => {
    const episode = await call("get_episode", { slug: ep2.canonicalUrl });
    expect(episode.value).toMatchObject({ episode: 2, title: ep2.title });
    const guests = episode.value?.guests as { name: string; company: string }[];
    expect(guests.map(guest => `${guest.name} (${guest.company})`))
      .toContain("João Moura (CrewAI)");

    const byNumber = await call("get_episode", { episode: 38 });
    expect(byNumber.value).toMatchObject({ title: ep38.title, chapters: [] });
    const walrus = await call("get_episode", { episode: 77 });
    expect(walrus.value).toMatchObject({
      title: ep77.title,
      guests: [{ name: "Kimberly Logan", company: "Walrus Protocol" }],
    });
    const found = await call("search_episodes", { query: "Griciunas" });
    assertEpisodeSearchCites(found.value);
    expect((found.value?.results as { episode: number }[])[0].episode).toBe(38);

    const excerpt = await call("get_transcript_excerpt", { episode: 77, at: "0:29" });
    const expected = [...ep77.transcript]
      .filter(segment => segment.seconds !== null && segment.seconds <= 29)
      .at(-1) ?? ep77.transcript[0];
    expect(excerpt.value?.anchor).toMatchObject({
      segment_index: expected.index, time: expected.time,
    });
    expect(excerpt.value?.url).toBe(expected.url);
    const segments = excerpt.value?.segments as { speaker: string; url: string }[];
    expect(segments.some(segment =>
      segment.url === expected.url && segment.speaker === expected.speaker
    )).toBe(true);
  });

  it("handles hostile searches and simple HTTP routes", async () => {
    for (const tool of ["search_transcripts", "search_episodes"]) {
      for (const query of ['"', "*", "-", ":", "''"]) {
        const result = await call(tool, { query });
        expect(result.error).toBe(true);
        expect(result.text).toContain("no searchable words");
      }
      for (const query of [
        "NEAR(", "AND OR NOT", "数据库", "Griciūnas", "title:foo", "(x OR y)",
        "a NEAR/3 b",
      ]) {
        const result = await call(tool, { query });
        expect(result.error).toBe(false);
        expect(Array.isArray(result.value?.results)).toBe(true);
        if (tool === "search_transcripts") assertSearchCites(result.value);
        else assertEpisodeSearchCites(result.value);
      }

      let longMessage = "";
      try {
        const result = await call(tool, { query: "x".repeat(1000) });
        expect(result.error).toBe(true);
        longMessage = result.text;
      } catch (error) {
        longMessage = String(error);
      }
      expect(longMessage).toMatch(/200/u);
    }

    const root = url.replace(/\/mcp$/u, "/");
    expect(await (await fetch(root)).text()).toContain("chainofthought.show");
    expect(await (await fetch(new URL("/health", url))).text()).toBe("ok");
    expect((await fetch(url)).status).toBe(405);
  });
});
