# Chain of Thought podcast archive MCP server

This read-only Model Context Protocol server lets AI agents and coding assistants search the transcripts and episode metadata of [Chain of Thought](https://chainofthought.show), the podcast hosted by Conor Bronsdon, and cite its episode pages. It needs no login or API key. It runs as a Cloudflare Worker with D1 full-text search.

## Endpoint

`https://mcp.chainofthought.show/mcp` is live. The transport is stateless Streamable HTTP. `GET /` describes the server and `GET /health` returns `ok`.

## Tools

| Tool | Inputs | Returns |
| --- | --- | --- |
| `search_transcripts` | `query` (up to 200 characters), `limit` (1–20, default 8), optional `episode` (1–9999) | Ranked passages with episode, guests, speaker, timestamp, snippet, moment URL and citation. |
| `search_episodes` | `query` (up to 200 characters), `limit` (1–20, default 8) | Ranked episodes with date, guests, summary, matching chapters, URL and citation. |
| `get_episode` | `episode` (1–9999) or `slug` (up to 300 characters, including a full episode URL) | Metadata, guests, chapters and episode, YouTube and audio links. |
| `get_transcript_excerpt` | `episode` (1–9999), optional `at` (a `segment_index` from search results, a passage URL or its `#t-` anchor, `m:ss` or `h:mm:ss`), `before` (0–5, default 2), `after` (0–10, default 5) | Up to 16 consecutive segments with individual URLs, plus anchor and pagination flags. |

### How search ranks results

Transcript search uses BM25 over passages, with a boost for passages from episodes whose title, guests, chapter titles or summary match the query. Passages containing all query words come before passages containing some. Near-identical passages, such as sponsor reads repeated across episodes, collapse to one result.

A `search_transcripts` result has this shape (text values abbreviated):

```json
{
  "episode": 77,
  "episode_title": "…",
  "guests": ["…"],
  "published_at": "…",
  "speaker": "…",
  "time": "…",
  "seconds": 29,
  "segment_index": 2,
  "snippet": "…",
  "match": "all_terms",
  "url": "https://chainofthought.show/podcast/…/#t-2",
  "episode_url": "https://chainofthought.show/podcast/…/",
  "cite": "Chain of Thought, chainofthought.show — https://chainofthought.show/podcast/…/#t-2"
}
```

## Connect

These steps follow each vendor's docs as of 2026-10-14. The endpoint must be deployed before a client can connect.

### Claude Code

#### Install in Claude Code

In a Claude Code session, add this repository as a plugin marketplace and install the plugin:

```text
/plugin marketplace add conorbronsdon/chain-of-thought-podcast-mcp
/plugin install chain-of-thought-podcast@chain-of-thought-podcast-mcp
```

The plugin connects to the public remote MCP endpoint without an API key. Its optional `/chain-of-thought-podcast:cite-chain-of-thought` skill helps find and cite podcast discussions.

#### Add the MCP server directly

Run the [Claude Code MCP command](https://code.claude.com/docs/en/mcp):

```sh
claude mcp add --transport http chain-of-thought https://mcp.chainofthought.show/mcp
```

This uses local scope by default. `--scope project` writes `.mcp.json`; a project entry is:

```json
{"mcpServers":{"chain-of-thought":{"type":"http","url":"https://mcp.chainofthought.show/mcp"}}}
```

`--scope user` makes it available across projects.

### Claude apps custom connector

In [Claude's connector settings](https://support.claude.com/en/articles/11175166-getting-started-with-custom-connectors-using-remote-mcp), open Customize > Connectors > **+ Add** > **Add custom connector**. Enter `chain-of-thought` and `https://mcp.chainofthought.show/mcp`, select **Continue**, choose **No sign in** under Authentication, then select **Add**. Free plans are limited to one custom connector. On Team plans only Owners and Primary Owners can add connectors; on Enterprise, Owners, Primary Owners and roles with Manage access to Libraries can.

### Cursor

Add this to `.cursor/mcp.json` for a project or `~/.cursor/mcp.json` globally, following the [Cursor MCP docs](https://cursor.com/docs/context/mcp):

```json
{"mcpServers":{"chain-of-thought":{"url":"https://mcp.chainofthought.show/mcp"}}}
```

### ChatGPT

Open [ChatGPT plugins](https://chatgpt.com/plugins), select the plus button, then **Add custom MCP server**. Enter `chain-of-thought` and a description. Under Connection, enter `https://mcp.chainofthought.show/mcp`. Configure authentication (this server needs none), review the risk warning, select **I understand and want to continue**, then **Create as a plugin** and review the discovered tools. A public HTTPS endpoint is required; account and workspace policies apply. See the [OpenAI connection guide](https://developers.openai.com/plugins/deploy/connect-chatgpt).

## Citing and usage terms

The source corpus states:

> Attribution: "Chain of Thought — chainofthought.show"
>
> Canonical: "Every record carries canonicalUrl. Cite that page, not this endpoint: it is the authoritative rendering and the one that gets corrected."
>
> Transcripts: "Machine-generated (ASR), with entity corrections applied during sync. Transcripts may contain errors; verify quotations against the recording."
>
> License: "CC-BY-4.0"
>
> Redistribution: "Transcript text and episode metadata are licensed CC BY 4.0 and published as a dataset at https://huggingface.co/datasets/conorbronsdon/chain-of-thought-podcast-transcripts. Credit Chain of Thought (chainofthought.show) and link the episode page."

`url` is the page to cite; for a transcript passage it includes a `#t-` anchor to open that segment. The anchor may have one or two numbers and is separate from `segment_index`. Pass the full URL or its anchor to `get_transcript_excerpt` to retrieve that passage. `episode_url` is the episode page without a segment anchor. `cite` combines attribution and `url` in the format `Chain of Thought, chainofthought.show — <url>`.

## Limits and freshness

Queries are limited to 200 characters. Search returns 1–20 results (default 8). Snippets are about 600 characters; excerpt segments are at most 1,500 characters, with at most 16 segments per excerpt. No tool returns a whole transcript. Some segments in early episodes 5, 6, 7 and 9 have no timestamp: `time` and `seconds` are `null`, while their URLs still work.

An hourly cron adds, changes or removes at most one episode per run, so a newly published episode is usually indexed within about an hour of appearing in `corpus.json` when there is no backlog. Successful tool results are cached for one hour; a repeated search can therefore return pre-ingest results for up to about another hour. Transcript corrections are picked up when the round-robin check reaches an episode; at one per hour, all 77 episodes take about 3.2 days. Logs record tool name, success, result count and duration. Query text is not logged.

## Development

Use Node 22.18 or newer:

```sh
npm ci
npm test
npm run typecheck
```

For the three-episode fixture, run these in order, with `dev:fixture` kept running for the integration test:

```sh
npm run build-sql:fixture
npm run db:fixture
npm run dev:fixture
MCP_URL=http://127.0.0.1:8787/mcp npm run test:integration
```

For the full corpus:

```sh
npm run build-sql
npm run db:full
npm run dev:full
npm run query -- --top 3 --compact search_transcripts '{"query":"..."}'
npm run eval
```

To test the cron locally, start `wrangler dev --test-scheduled` and call:

```sh
curl "http://127.0.0.1:8787/__scheduled?cron=23+*+*+*+*"
```

`dist/` and `.cache/` hold transcript text and are gitignored. Do not commit or publish them. See [Deploying](DEPLOY.md) and the [design notes](docs/DESIGN.md).

## License

The code in this repository is MIT licensed; see [LICENSE](LICENSE). That license does not cover podcast transcripts, episode metadata or other content served by chainofthought.show, which this server reads at runtime. The usage terms above apply to that content.
