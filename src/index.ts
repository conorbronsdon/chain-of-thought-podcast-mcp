import { createMcpHandler } from "agents/mcp/server";
import { localhostAllowedHostnames, localhostAllowedOrigins } from "@modelcontextprotocol/server";
import { createServer } from "./server.ts";
import { runRefresh } from "./refresh.ts";

const list = (value: string): string[] => value.split(",").map(item => item.trim()).filter(Boolean);
const plain = { "content-type": "text/plain; charset=utf-8" };
const MAX_MCP_BODY = 8 * 1024;

export async function boundedMcpRequest(request: Request): Promise<Request | Response> {
  const length = request.headers.get("content-length");
  if (length !== null && Number(length) > MAX_MCP_BODY) {
    return new Response("MCP request body exceeds 8 KB", { status: 413, headers: plain });
  }
  const reader = request.body?.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  if (reader) {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_MCP_BODY) {
        await reader.cancel();
        return new Response("MCP request body exceeds 8 KB", { status: 413, headers: plain });
      }
      chunks.push(value);
    }
  }
  const body = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    if (Array.isArray(JSON.parse(new TextDecoder().decode(body)))) {
      return Response.json({
        jsonrpc: "2.0", id: null,
        error: { code: -32600, message: "JSON-RPC batch requests are not supported" },
      }, { status: 400 });
    }
  } catch {
    // The MCP handler reports malformed JSON using its existing protocol response.
  }
  return new Request(request, { body });
}

// Configures the stateless MCP handler with host and browser origin restrictions.
export function mcpHandler(request: Request, env: Env) {
  const host = new URL(request.url).hostname;
  const local = localhostAllowedHostnames().includes(host);
  const workers = host.endsWith(".workers.dev");
  return createMcpHandler(() => createServer(env, new URL(request.url).origin), {
    route: "/mcp",
    ...(!local && !workers ? { allowedHostnames: list(env.MCP_HOSTNAMES) } : {}),
    allowedOriginHostnames: [
      ...localhostAllowedOrigins(),
      ...list(env.MCP_ORIGIN_HOSTNAMES),
      ...(workers ? [host] : []),
    ],
    onerror: error => console.error(JSON.stringify({
      event: "mcp_handler_error",
      message: error.message,
    })),
  });
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    try {
      const url = new URL(request.url);
      if (url.pathname === "/" && (request.method === "GET" || request.method === "HEAD")) {
        const body = [
          "Chain of Thought podcast archive",
          "Read-only MCP server for searching and citing the Chain of Thought podcast archive, "
            + "hosted by Conor Bronsdon.",
          `Endpoint: ${url.origin}/mcp (Streamable HTTP)`,
          "Tools: search_transcripts, search_episodes, get_episode, get_transcript_excerpt",
          "Podcast: https://chainofthought.show",
          "README: https://github.com/conorbronsdon/chain-of-thought-podcast-mcp#readme",
          "Cite the episode pages on chainofthought.show, not this server.",
        ].join("\n");
        return new Response(request.method === "HEAD" ? null : body, { headers: plain });
      }
      if (url.pathname === "/health" && request.method === "GET") {
        return new Response("ok", { headers: plain });
      }
      if (url.pathname === "/mcp") {
        const bounded = request.method === "POST" ? await boundedMcpRequest(request) : request;
        if (bounded instanceof Response) return bounded;
        return mcpHandler(bounded, env)(bounded, env, ctx);
      }
      return new Response("Not found", { status: 404, headers: plain });
    } catch (error) {
      console.error(JSON.stringify({
        event: "router_error",
        message: error instanceof Error ? error.message : String(error),
      }));
      return new Response("Internal server error", { status: 500, headers: plain });
    }
  },

  scheduled(_controller: ScheduledController, env: Env, ctx: ExecutionContext): void {
    if (env.REFRESH_ENABLED !== "true") {
      console.log(JSON.stringify({ event: "refresh", action: "skipped", reason: "disabled" }));
      return;
    }
    ctx.waitUntil(runRefresh({
      db: env.DB,
      fetch,
      now: new Date(),
      baseUrl: env.CORPUS_BASE_URL,
    }).then(result => {
      console.log(JSON.stringify({ event: "refresh", ...result }));
    }).catch(error => {
      console.error(JSON.stringify({
        event: "refresh",
        action: "error",
        message: error instanceof Error ? error.message : String(error),
      }));
    }));
  },
} satisfies ExportedHandler<Env>;
