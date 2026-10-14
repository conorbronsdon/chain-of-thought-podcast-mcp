import { readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  CLIENT_CAPABILITIES_META_KEY,
  CLIENT_INFO_META_KEY,
  PROTOCOL_VERSION_META_KEY,
} from "@modelcontextprotocol/client";
import { mcpHandler } from "../src/index.ts";
import type { EpisodeFile, Manifest } from "../src/types.ts";
import { D1Shim, d1 } from "../test/helpers/d1-shim.ts";
import { fakeExecutionContext } from "../test/helpers/context.ts";
import { generateSql } from "./build-sql.ts";

async function main() {
  const manifest = JSON.parse(await readFile(".cache/corpus/corpus.json", "utf8")) as Manifest;
  const entries = manifest.episodes.filter(entry => [77, 38, 2].includes(entry.episode));
  const files: EpisodeFile[] = [];
  for (const entry of entries) {
    const path = join(".cache/corpus/podcast", `${entry.slug}.json`);
    files.push(JSON.parse(await readFile(path, "utf8")) as EpisodeFile);
  }

  const shim = new D1Shim();
  await shim.exec(await generateSql(manifest, files, {
    now: new Date().toISOString(), only: [77, 38, 2],
  }));
  const env: Env = {
    DB: d1(shim),
    CORPUS_BASE_URL: "https://chainofthought.show",
    REFRESH_ENABLED: "false",
    ALLOW_WORKERS_DEV: "false",
    MCP_HOSTNAMES: "",
    MCP_ORIGIN_HOSTNAMES: "",
  };
  const ctx = fakeExecutionContext();
  const bodies = [
    {
      jsonrpc: "2.0", id: 1, method: "initialize",
      params: {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "bench", version: "1" },
      },
    },
    { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} },
    {
      jsonrpc: "2.0", id: 3, method: "tools/call",
      params: { name: "search_transcripts", arguments: { query: "agent memory" } },
    },
  ];

  for (const [i, body] of bodies.entries()) {
    const times: number[] = [];
    for (let j = 0; j < 55; j++) {
      const payload = i === 0 ? body : {
        ...body,
        params: {
          ...body.params,
          _meta: {
            [PROTOCOL_VERSION_META_KEY]: "2026-07-28",
            [CLIENT_CAPABILITIES_META_KEY]: {},
            [CLIENT_INFO_META_KEY]: { name: "bench", version: "1" },
          },
        },
      };
      const request = new Request("http://localhost/mcp", {
        method: "POST",
        headers: {
          host: "localhost",
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
          "MCP-Protocol-Version": i === 0 ? "2025-06-18" : "2026-07-28",
          ...(i ? { "Mcp-Method": body.method } : {}),
          ...(i === 2 ? { "Mcp-Name": "search_transcripts" } : {}),
        },
        body: JSON.stringify(payload),
      });
      const start = performance.now();
      const response = await mcpHandler(request, env)(request, env, ctx);
      const text = await response.text();
      if (!response.ok || text.includes('"error":{"code"')) {
        throw new Error(`${body.method}: HTTP ${response.status}: ${text}`);
      }
      if (j >= 5) times.push(performance.now() - start);
    }
    times.sort((a, b) => a - b);
    console.log(JSON.stringify({
      request: ["initialize", "tools/list", "tools/call search_transcripts"][i],
      median_ms: times[24],
      p95_ms: times[47],
    }));
  }
  shim.close();
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
