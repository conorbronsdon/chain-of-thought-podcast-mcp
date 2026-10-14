import { expect, it, vi } from "vitest";
import worker, { boundedMcpRequest, mcpHandler } from "../src/index.ts";
import { generateSql } from "../scripts/build-sql.ts";
import { SCHEMA } from "../src/schema.ts";
import { getExcerptSchema, searchTranscriptsSchema } from "../src/server.ts";
import { fakeExecutionContext } from "./helpers/context.ts";
import { D1Shim, d1 } from "./helpers/d1-shim.ts";
import { files, manifest } from "./helpers/fixtures.ts";

const envFor = (shim: D1Shim): Env => ({
  DB: d1(shim),
  CORPUS_BASE_URL: "https://chainofthought.show",
  REFRESH_ENABLED: "false",
  MCP_HOSTNAMES: "",
  MCP_ORIGIN_HOSTNAMES: "",
});

const requestFor = (method: string, params: Record<string, unknown>) => new Request(
  "http://localhost/mcp",
  {
    method: "POST",
    headers: {
      host: "localhost",
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      "MCP-Protocol-Version": "2025-06-18",
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  },
);

it("rejects out-of-range input and applies defaults", () => {
  for (const limit of [0, 21, 1.5]) {
    expect(searchTranscriptsSchema.safeParse({ query: "x", limit }).success).toBe(false);
  }
  expect(searchTranscriptsSchema.safeParse({ query: "x".repeat(201) }).success).toBe(false);
  expect(getExcerptSchema.safeParse({ episode: 2, before: 6 }).success).toBe(false);
  expect(getExcerptSchema.safeParse({ episode: 2, after: 11 }).success).toBe(false);
  expect(getExcerptSchema.safeParse({ episode: 0 }).success).toBe(false);
  expect(searchTranscriptsSchema.parse({ query: "word" }).limit).toBe(8);
  expect(getExcerptSchema.parse({ episode: 2 })).toMatchObject({ before: 2, after: 5 });
});

it("rejects a long query through the installed MCP handler", async () => {
  const shim = new D1Shim();
  await shim.exec(SCHEMA);
  const env = envFor(shim);
  const ctx = fakeExecutionContext();
  const request = requestFor("tools/call", {
    name: "search_transcripts",
    arguments: { query: "x".repeat(201) },
  });
  const response = await mcpHandler(request, env)(request, env, ctx);
  const text = await response.text();
  expect(response.status).not.toBe(500);
  expect(text).toMatch(/isError|"error"/u);
  shim.close();
});

it("lists annotated tools and serves health without a database query", async () => {
  const shim = new D1Shim();
  await shim.exec(SCHEMA);
  const env = envFor(shim);
  const ctx = fakeExecutionContext();
  const health = await worker.fetch(new Request("http://localhost/health"), env, ctx);
  expect(await health.text()).toBe("ok");

  const request = requestFor("tools/list", {});
  const response = await mcpHandler(request, env)(request, env, ctx);
  const text = await response.text();
  const json = text.startsWith("event:")
    ? text.split("\n").find(line => line.startsWith("data: "))?.slice(6) ?? ""
    : text;
  const body = JSON.parse(json) as {
    result: { tools: { annotations: Record<string, boolean> }[] };
  };
  expect(body.result.tools).toHaveLength(4);
  for (const tool of body.result.tools) {
    expect(tool.annotations).toMatchObject({
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    });
  }
  shim.close();
});

it("rejects declared and streamed bodies over 8 KB before reaching MCP", async () => {
  const shim = new D1Shim();
  const env = envFor(shim);
  const ctx = fakeExecutionContext();
  const declared = new Request("http://localhost/mcp", {
    method: "POST", headers: { "content-length": "8193" }, body: "{}",
  });
  expect((await worker.fetch(declared, env, ctx)).status).toBe(413);
  const streamed = new Request("http://localhost/mcp", {
    method: "POST", body: "x".repeat(8193),
  });
  expect((await worker.fetch(streamed, env, ctx)).status).toBe(413);
  expect(shim.preparedSql).toHaveLength(0);
  shim.close();
});

it("rejects JSON-RPC batches and preserves a single request's headers and body", async () => {
  const shim = new D1Shim();
  const env = envFor(shim);
  const ctx = fakeExecutionContext();
  const batch = new Request("http://localhost/mcp", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify([{ jsonrpc: "2.0", id: 1, method: "tools/list" }]),
  });
  const rejected = await worker.fetch(batch, env, ctx);
  expect(rejected.status).toBe(400);
  expect(await rejected.json()).toMatchObject({ error: { code: -32600 } });
  const single = requestFor("tools/list", {});
  single.headers.set("x-test-marker", "kept");
  const bounded = await boundedMcpRequest(single);
  expect(bounded).toBeInstanceOf(Request);
  if (!(bounded instanceof Request)) throw new Error("Expected Request");
  expect(bounded.headers.get("x-test-marker")).toBe("kept");
  expect(JSON.parse(await bounded.text())).toMatchObject({ method: "tools/list" });
  const response = await worker.fetch(requestFor("tools/list", {}), env, ctx);
  expect(response.status).toBe(200);
  shim.close();
});

it("reuses normalized tool results from the Workers cache without D1 reads", async () => {
  const shim = new D1Shim();
  await shim.exec(await generateSql(manifest(), files, {
    now: "2026-01-02T00:00:00.000Z",
  }));
  const saved = new Map<string, Response>();
  vi.stubGlobal("caches", { default: {
    match: async (key: Request) => saved.get(key.url)?.clone(),
    put: async (key: Request, response: Response) => { saved.set(key.url, response.clone()); },
  } });
  try {
    const env = envFor(shim);
    const ctx = fakeExecutionContext();
    const call = async (query: string) => {
      const response = await worker.fetch(requestFor("tools/call", {
        name: "search_transcripts", arguments: { query, limit: 2 },
      }), env, ctx);
      await response.text();
      return response;
    };
    expect((await call("portable memory")).status).toBe(200);
    const count = shim.preparedSql.length;
    expect(count).toBeGreaterThan(0);
    expect(saved.size).toBe(1);
    expect((await call("  PORTABLE   MEMORY  ")).status).toBe(200);
    expect(shim.preparedSql).toHaveLength(count);
    expect(saved.size).toBe(1);
    expect(saved.values().next().value?.headers.get("cache-control"))
      .toBe("public, max-age=3600");
  } finally {
    vi.unstubAllGlobals();
    shim.close();
  }
});
