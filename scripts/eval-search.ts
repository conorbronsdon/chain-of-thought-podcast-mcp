import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";

// These expectations describe the full 77-episode corpus as of 2026-10-14.
const checks = [
  { query: "Block MCP rollout 12,000 employees", expectEpisodeInTop: 48, top: 1 },
  { query: "Qwen summarization cost", expectEpisodeInTop: 49, top: 1 },
  { query: "portable agent memory switching models", expectEpisodeInTop: 77, top: 1 },
  { query: "why multi-agent systems fail", expectEpisodeInTop: 33, top: 1 },
  { query: "Jack Dorsey", expectEpisodeInTop: 48, top: 1 },
  { query: "Snowdon catastrophic forgetting", expectEpisodeInTop: 69, top: 1 },
];

const args = process.argv.slice(2);
const urlFlag = args.indexOf("--url");
const url = urlFlag < 0 ? "http://127.0.0.1:8787/mcp" : args[urlFlag + 1];
if (!url || (urlFlag >= 0 && args.length !== 2) || (urlFlag < 0 && args.length !== 0)) {
  console.error("Usage: node scripts/eval-search.ts [--url URL]");
  process.exit(2);
}

const client = new Client(
  { name: "cot-archive-search-eval", version: "0.1.0" },
  { versionNegotiation: { mode: "auto" } },
);

async function call<T>(name: string, arguments_: Record<string, unknown>): Promise<T> {
  const response = await client.callTool({ name, arguments: arguments_ });
  const content = response.content.find(item => item.type === "text");
  if (response.isError === true || content?.type !== "text") {
    throw new Error(content?.type === "text" ? content.text : "No text response");
  }
  return JSON.parse(content.text) as T;
}

type Hit = { episode: number; url: string };

try {
  await client.connect(new StreamableHTTPClientTransport(new URL(url)));
  for (const check of checks) {
    try {
      const data = await call<{ results: Hit[] }>("search_transcripts", {
        query: check.query, limit: 3,
      });
      const topThree = data.results.slice(0, 3)
        .map(hit => `${hit.episode} ${new URL(hit.url).hash}`).join(", ");
      const passed = data.results.slice(0, check.top)
        .some(hit => hit.episode === check.expectEpisodeInTop);
      console.log(`${passed ? "PASS" : "FAIL"} ${check.query}: ${topThree || "no results"}`);
      if (!passed) process.exitCode = 1;
    } catch (error) {
      console.log(`FAIL ${check.query}: ${String(error)}`);
      process.exitCode = 1;
    }
  }
  try {
    const excerpt = await call<{ anchor: { segment_index: number } }>(
      "get_transcript_excerpt", { episode: 75, at: "#t-2-1" },
    );
    const passed = excerpt.anchor.segment_index === 3;
    console.log(`${passed ? "PASS" : "FAIL"} episode 75 #t-2-1: segment_index ${excerpt.anchor.segment_index}`);
    if (!passed) process.exitCode = 1;
  } catch (error) {
    console.log(`FAIL episode 75 #t-2-1: ${String(error)}`);
    process.exitCode = 1;
  }
} catch (error) {
  console.error(`FAIL connect ${url}: ${String(error)}`);
  process.exitCode = 1;
} finally {
  await client.close();
}
