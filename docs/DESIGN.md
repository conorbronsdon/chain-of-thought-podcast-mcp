# Design notes

This server is a read-only MCP endpoint over the Chain of Thought transcript archive. It runs as one
Cloudflare Worker (`cot-archive-mcp`) with one D1 database (`cot-archive`). Search runs inside D1 through
SQLite FTS5, so the Worker does little more than validate input, run one or two SQL queries and shape JSON.

Research date: 2026-10-14. Doc pages were read on that date; quotes below are from those pages.

## 1. Source data (checked against the live site)

| Endpoint | What it holds | Notes |
| --- | --- | --- |
| `https://chainofthought.show/corpus.json` | Manifest: `schemaVersion` 1, `dataUpdatedAt`, `counts` (77 episodes, 77 with transcript, 8,537 segments), `endpoints`, `usage`, and one entry per episode: `slug, episode, season, title, publishedAt, guests (string[]), canonicalUrl, json, hasTranscript, segmentCount` | No per-episode updated timestamp or hash. About 50 KB. |
| `https://chainofthought.show/corpus.jsonl` | One transcript segment per line: `schemaVersion, slug, episode, guid, episodeTitle, publishedAt, segmentIndex, time, seconds, speaker, text, canonicalUrl (…/#t-N), usage` | 8,537 lines, 12.3 MB. Segment text averages 418 chars, max 7,674. |
| `https://chainofthought.show/podcast/{slug}.json` | Everything for one episode: `schemaVersion, slug, episode, season, guid, title, canonicalUrl, publishedAt, durationSeconds, guests [{name, company or null}], audioUrl, transistorUrl, youtubeUrl, summary, chapters [{time, seconds, label}], hasTranscript, segmentCount, transcript [{index, time, seconds, speaker, text, url}], usage` | 41 KB to 152 KB. 11 of 77 episodes have no chapters; 2 guests have `company: null`. Served with a strong `ETag` and `Cache-Control: public, max-age=0, must-revalidate`. |

Checks run on 2026-10-14 over all 77 episode files: every segment in `corpus.jsonl` matches the
per-episode `transcript` entry exactly (text and URL), indexes are contiguous from 0, and every manifest
entry matches its episode file (number, slug, title, canonical URL).

Three data details found while building, all handled by the server:

- 90 segments in episodes 5, 6, 7 and 9 have `"time": null, "seconds": null`. They keep their index,
  speaker, text and URL. The `time` and `seconds` columns are nullable, search returns `null` for them,
  and excerpt lookups by timestamp skip them.
- 2,583 of 8,537 segment URLs do not end in `#t-<index>`. Two anchor formats exist: `t-N` (7,037) and
  `t-N-N` (1,500), e.g. episode 75 index 3 is `#t-2-1`. The server stores each URL as published and
  resolves `#t-…` anchors by matching the stored URL, never by parsing a number out of it.
- The ASR text has entity errors the episode metadata does not. Episode 49 spells Qwen as "Quen" and
  "Quinn" in the transcript, while its summary and chapter titles say "Qwen"; episode 48's intro says
  "Train of Thought". This is one reason search ranking uses episode metadata (section 6).

There are no takeaways or FAQ fields in any endpoint, so the tools do not return them.

Ingest therefore reads the manifest plus the 77 per-episode files. The JSONL file holds a subset of the
same data and is not needed.

### Usage terms (from `corpus.json` `usage`)

- attribution: "Chain of Thought — chainofthought.show"
- canonical: "Every record carries canonicalUrl. Cite that page, not this endpoint: it is the authoritative rendering and the one that gets corrected."
- transcripts: "Machine-generated (ASR), with entity corrections applied during sync. Transcripts may contain errors; verify quotations against the recording."
- redistribution: "This endpoint grants no additional licence to redistribute transcript text as a dataset or corpus. Link to and cite the episode page."

How the server respects them: every result carries the canonical URL (per-segment `#t-N` deep links for
transcript passages) and a `cite` string; snippets are capped near 600 characters; excerpts are capped at
16 contiguous segments; no tool returns a whole transcript or an export. The repo does not commit
transcript text: the corpus cache and generated SQL are gitignored.

## 2. Platform findings

### (a) D1 supports FTS5 and bm25()

- D1 import/export guide, Known limitations: "D1 supports virtual tables for full-text search using
  SQLite's FTS5 module." The same bullet says export is not supported for databases with virtual tables
  ("delete any virtual tables, export, and then recreate virtual tables").
  https://developers.cloudflare.com/d1/best-practices/import-export-data/
- D1 SQL statements page lists supported extensions: "FTS5 module for full-text search (including
  `fts5vocab`)", the JSON extension, and math functions.
  https://developers.cloudflare.com/d1/sql-api/sql-statements/
- `bm25()` is not named in the D1 docs. The docs point to the workerd source for the full function list.
  That allowlist (`ALLOWED_SQLITE_FUNCTIONS` in `src/workerd/util/sqlite.c++`) contains `match`,
  `highlight`, `bm25`, `snippet`, `json_each` and `json_extract`, and the virtual-table authorizer allows
  module `fts5`. https://github.com/cloudflare/workerd/blob/main/src/workerd/util/sqlite.c%2B%2B
- `json_each` is documented as supported, with a Worker example binding a JSON array to `json_each(?1)`.
  https://developers.cloudflare.com/d1/sql-api/query-json/
- Local proof: the integration test and full ingest run FTS5 `MATCH` + `bm25()` + `snippet()` in local D1
  (workerd). See the README test section and the final report.

Decision: FTS5 external-content tables (`content='segments'`, `content='episodes'`), no triggers. Index
maintenance is explicit and set-based (see section 4).

### (b) Workers Free plan CPU limits

From https://developers.cloudflare.com/workers/platform/limits/:

| Limit | Workers Free | Workers Paid |
| --- | --- | --- |
| CPU time per HTTP request | 10 ms | 5 min (default 30 s) |
| CPU time per Cron Trigger | 10 ms | 30 s (< 1 h interval), 15 min (>= 1 h interval) |
| Subrequests | 50 per request | 10,000 per request |
| Cron Triggers per account | 5 | 250 |

"Waiting on network requests (such as `fetch()` calls, KV reads, or database queries) does not count
toward CPU time." Cron wall time is up to 15 minutes.

D1 limits (https://developers.cloudflare.com/d1/platform/limits/): 50 queries per Worker invocation on
Free; 100 bound parameters per query; 100 KB maximum SQL statement length; 2 MB maximum string, BLOB or
row size; "Limits for individual queries ... apply to each individual statement contained within a batch
statement." The page does not say whether batch statements count individually toward the 50-query
budget, so the refresh path keeps the total number of statements under 15 either way.

D1 pricing (https://developers.cloudflare.com/d1/platform/pricing/): Free plan includes 5 million rows
read and 100,000 rows written per day. Since 2026-09-01, queries on the Free plan fail once the daily
limit is reached (https://developers.cloudflare.com/changelog/post/2026-09-01-d1-free-tier-limit-enforcement/).
The full remote ingest is the only operation that writes a large number of rows; see the row counts in
the final report and the note in DEPLOY.md.

What this means for the design:

- Search: one Worker invocation runs input validation, at most two D1 queries (all-terms, then
  any-terms fill if needed) and JSON shaping. No transcript text is parsed in the Worker.
- Refresh: the cron fetches `corpus.json` (one subrequest) and at most one episode file (one more).
  Change detection compares stored canonical manifest strings, which costs about 0.3 ms for 77 entries
  in Node on this machine; parsing, hashing and preparing the largest episode file (152 KB) costs about
  1.1 ms. The episode is written in one D1 batch, with all segment rows passed as a single JSON
  parameter to `json_each(?)`, so the Worker never builds per-row statements.
- Conclusion: the cron fits the Free plan, so it ships enabled (hourly), with a `REFRESH_ENABLED` var
  as a kill switch and a documented manual refresh path.
- Request path measurement (`npm run bench`: the real `createMcpHandler` in Node over in-process SQLite
  with 3 real episodes, 50 runs after warmup, wall time, so it includes the SQL work that D1 does
  off-Worker in production): legacy `initialize` median 0.9 ms (p95 2.3 ms), `tools/list` median 1.2 ms
  (p95 1.5 ms), `tools/call search_transcripts` median 1.3 ms (p95 2.2 ms). Cold start is not included.
  Workers CPU time is not measurable inside `wrangler dev`, so treat these as estimates, and check
  `exceededCpu` in Workers metrics after deploy.

### (c) Stateless Streamable HTTP without Durable Objects

- Agents SDK v0.20.0 (changelog 2026-07-27) added support for the MCP 2026-07-28 release candidate:
  "Workers can serve tools, prompts, resources, and elicitation without an MCP transport session or
  Durable Object." https://developers.cloudflare.com/changelog/post/2026-07-27-agents-sdk-v0.20.0-mcp-sdk-v2/
- Handler API: `createMcpHandler(factory, options)` from `agents/mcp/server` takes a factory that
  returns an `McpServer` from `@modelcontextprotocol/server` (SDK v2) and creates one server per request.
  The same route serves 2026-07-28 clients and, with the default `legacy: "stateless"`, legacy clients
  that send `initialize`. In the legacy lane, "Each POST creates a new server and transport", "HTTP GET
  and DELETE return 405" and no session ID persists.
  https://developers.cloudflare.com/agents/model-context-protocol/apis/handler-api/
- Version pinning: the handler page says to "Use the exact MCP versions required by your installed
  Agents release." `agents@0.24.0` declares exact peers `@modelcontextprotocol/server@2.0.0`,
  `@modelcontextprotocol/client@2.0.0` and `@modelcontextprotocol/sdk@1.30.0`.
- Host and Origin checks (read from the handler source in `agents@0.24.0`): if `allowedHostnames` is
  unset, the handler checks Host only for localhost and `*.workers.dev` endpoints; if set, the list
  replaces those defaults. The server therefore passes `allowedHostnames` only when the request host is
  not localhost or `workers.dev`, using the `MCP_HOSTNAMES` var (`mcp.chainofthought.show`). Browser
  Origins default to localhost, the `workers.dev` host and the CORS origin; the server adds
  `chainofthought.show` and `mcp.chainofthought.show`. Requests without an Origin header (Claude Code,
  Cursor, server-side connectors) are accepted.

Decision: `agents@0.24.0` `createMcpHandler` + `@modelcontextprotocol/server@2.0.0`, route `/mcp`,
no Durable Objects, no sessions.

### (d) Workers Rate Limiting binding on the Free plan

- The binding page (https://developers.cloudflare.com/workers/runtime-apis/bindings/rate-limit/, last
  updated 2026-10-12) documents the `ratelimits` config (`namespace_id`, `simple.limit`, `simple.period`
  of 10 or 60 seconds) and says limits are "local to the Cloudflare location that your Worker runs in"
  and "permissive, eventually consistent". It does not mention plans or pricing.
- The GA changelog (2025-09-19) and the Workers pricing page do not state plan availability either.

Decision: the docs do not confirm Free-plan availability, so the binding is not configured. The gap is
covered in part by input caps (query <= 200 chars, limit <= 20, excerpts <= 16 segments) and by the
Free plan's own ceilings (100,000 Worker requests per day; D1 daily row limits). DEPLOY.md describes two
options: a WAF rate limiting rule (the Free zone plan includes 1 rule, counted per IP, 10-second period,
matched on path; https://developers.cloudflare.com/waf/rate-limiting-rules/), or the Workers binding once
availability is confirmed for the account.

## 3. Dependencies

Pinned exact versions, each published at least two weeks before 2026-10-14:

| Package | Version | Published |
| --- | --- | --- |
| agents | 0.24.0 | 2026-09-18 |
| @modelcontextprotocol/server | 2.0.0 | 2026-07-27 |
| zod | 4.6.5 | 2026-09-13 |
| wrangler (dev) | 4.144.0 | 2026-09-29 |
| @modelcontextprotocol/client (dev, tests) | 2.0.0 | 2026-07-27 |
| @modelcontextprotocol/sdk (dev, legacy-client test; also a peer of agents) | 1.30.0 | 2026-07-27 |
| vitest (dev) | 5.0.2 | 2026-09-25 |
| typescript (dev) | 6.0.3 | 2026-04-16 |
| @types/node (dev) | 24.19.0 | 2026-09-25 |

`compatibility_date` is pinned to `2026-09-26`, the date of the workerd build bundled with wrangler
4.144.0 (`workerd@1.20260926.1`).

## 4. Storage

```
episodes(episode PK, slug UNIQUE, season, guid, title, published_at, duration_seconds, canonical_url,
         json_url, audio_url, transistor_url, youtube_url, summary, guests_json, guests_text,
         chapters_json, chapters_text, segment_count, manifest_entry, content_hash, etag,
         ingested_at, checked_at)
segments(id PK = episode * 100000 + idx, episode, idx, time NULL, seconds NULL, speaker, text, url)
segments_fts  FTS5(text, speaker)                             content='segments' content_rowid='id'
episodes_fts  FTS5(title, guests_text, chapters_text, summary) content='episodes' content_rowid='episode'
meta(key PK, value)
```

Tokenizer: `porter unicode61 remove_diacritics 2` (stemming, case folding, "Griciunas" matches
"Griciūnas").

Index maintenance without triggers:

- Full ingest (`npm run build-sql`, then `wrangler d1 execute ... --file`): schema with `IF NOT EXISTS`,
  per-episode delete + multi-row inserts (each statement under 90 KB), upsert of each episode row,
  deletion of episodes no longer in the manifest, then `INSERT INTO x_fts(x_fts) VALUES('rebuild')` for
  both FTS tables, then the `meta` rows. Running the file twice yields the same state. No
  `BEGIN`/`COMMIT` (D1 import rejects nested transactions).
- Refresh (cron): one D1 batch, which runs as a transaction: FTS `'delete'` rows selected from the old
  content, delete old segments, insert new segments from `json_each(?)`, FTS insert selected from the new
  content, and the same three steps for the episode row.

### Full ingest, measured locally (2026-10-14)

- `node scripts/build-sql.ts` (online, 78 requests, 26 s): 77 episodes, 8,537 segments, 249 statements,
  5.3 MB, largest statement 89,875 bytes (limit 100,000).
- `wrangler d1 execute cot-archive --local --file dist/ingest.sql`: 3.4 s. Row counts afterwards:
  77 episodes and 8,537 segments, equal to `corpus.json` `counts`; 90 segments with null `time`.
  FTS5 `integrity-check` passes on both FTS tables.
- Rows written, summed from `meta.rows_written` of each statement run through a local D1 binding
  (`getPlatformProxy`): 8,715 on an empty database, 17,235 when re-run over a loaded one (the per-episode
  deletes count too). The local counter reports each FTS `rebuild` as 1 row; the FTS shadow tables hold
  about 9,550 rows after a build (`segments_fts_docsize` 8,537, `_data` 477, `_idx` 425, plus the episode
  index). If D1 counts those writes in production, expect roughly 18,000 to 37,000 rows written per
  full ingest, well under the Free plan's 100,000 per day, but avoid running it many times in one day.
- Estimate, not measured: a cron refresh of one episode deletes and reinserts its segments and FTS
  entries, about 4 × its segment count (roughly 200 to 1,500 rows), plus a few meta rows.

## 5. Change detection (refresh)

The manifest has no per-episode timestamp or hash, so the server stores:

- `manifest_entry`: a canonical JSON string of the manifest entry. A difference means new metadata
  (title, guests, segment count, slug and so on).
- `content_hash`: SHA-256 of a canonical JSON serialization of everything stored from the episode file.
  A difference means changed content, including transcript corrections that keep the segment count.
- `etag`: the episode file's HTTP ETag, used only to make round-robin checks cheap (`If-None-Match`).

Each run handles at most one episode, in this order: a removed episode (only when the manifest looks
complete), a new episode (highest number first), an episode whose manifest entry changed, then a
round-robin check of the episode with the oldest `checked_at`. Hourly runs re-verify all 77 episodes in
about 3.2 days, so corrections that do not touch the manifest are picked up within that window.

## 6. Search ranking

`search_transcripts` ranks passages with FTS5 `bm25(segments_fts, 1.0, 0.25)` (text weighted over
speaker) plus `0.4 × bm25(episodes_fts, 8.0, 6.0, 3.0, 1.0)` for the passage's episode when the
episode's title, guests, chapter titles or summary match the query (terms joined with OR). Passages
containing all query terms come first; an any-term pass fills the remaining slots. Passages whose
snippets share the same first 80 letters and digits collapse to one result, which removes repeated
sponsor reads.

Why: on the full corpus, plain passage bm25 put sponsor reads in all top 3 slots for "portable agent
memory switching models", and missed episode 49 for "Qwen summarization cost" because its transcript
spells Qwen as "Quen" and "Quinn" while its summary and chapter titles spell it correctly. The weight
0.4 came from comparing 0, 0.25 and 0.5 on the queries below: 0.25 left episode 70 above 48 for the
Block query; 0.4 and 0.5 both matched, and 0.4 keeps more weight on the passage itself.

`npm run eval` checks the full corpus (expected top episode per query, as of 2026-10-14):

| Query | Top 3 (episode #anchor) |
| --- | --- |
| Block MCP rollout 12,000 employees | 48 #t-2, 70 #t-55-1, 48 #t-0 |
| Qwen summarization cost | 49 #t-3, 49 #t-4, 49 #t-7 |
| portable agent memory switching models | 77 #t-1, 73 #t-10-2 (sponsor read), 77 #t-0 |
| why multi-agent systems fail | 33 #t-57, 33 #t-60, 33 #t-55 |
| Jack Dorsey | 48 #t-16, 48 #t-0, 20 #t-80 |
| Snowdon catastrophic forgetting | 69 #t-22, 69 #t-10, 53 #t-22 |

The same script checks that `#t-2-1` in episode 75 resolves to segment index 3. Run against the
3-episode fixture it fails and exits 1, which shows the check can fail.

## 7. Verification record (local, 2026-10-14)

- Unit tests: 25 pass (`npx vitest run`), offline, synthetic data, node:sqlite with FTS5. They cover the
  sanitizer (including a seeded fuzz loop whose output runs as `MATCH` against real FTS5), input bounds,
  formatting, ingest validation and hashing, SQL generation (idempotent re-run), the refresh logic with
  a fake fetch, and the four tools.
- Integration: 4 pass against `wrangler dev --local` with episodes 77, 38 and 2 in local D1, through both
  `@modelcontextprotocol/client@2.0.0` and the legacy `@modelcontextprotocol/sdk@1.30.0` client.
  Expected values are read from the real episode files at test time.
- Hostile queries through the live tool: `"`, `*`, `-`, `:` and the empty string return the "no
  searchable words" error; `NEAR(`, `AND OR NOT`, `title:foo`, `(x OR y)`, `a NEAR/3 b`, CJK and accented
  input return results or an empty list; 1,000 characters fails schema validation (max 200). No input
  produced an FTS syntax error.
- Origin: a browser `Origin: https://evil.example` gets 403; `https://chainofthought.show` and
  `http://localhost:6274` pass. `GET /mcp` is 405 and unknown paths are 404.
- Cron, fixture database, live site: three runs ingested episodes 76, 75 and 74 (one per run, newest
  first); FTS5 `integrity-check` passed afterwards.
- Cron, full database: two runs returned `checked` / `not_modified` (ETag stored by build-sql, sent as
  `If-None-Match`). After altering one episode 9 segment and clearing its hash and ETag, the next run
  re-ingested episode 9 (`content_changed`): the altered text was gone, its 21 null-timestamp segments
  were intact, and FTS `integrity-check` passed. With only the ETag cleared, episodes 5 and 50 returned
  `checked` / `content_unchanged`, so the Worker computes the same SHA-256 as the Node build script.
- `server.json` validates against
  https://static.modelcontextprotocol.io/schemas/2025-12-11/server.schema.json (the latest released
  schema per the registry's server-json CHANGELOG) using `@cfworker/json-schema`; a copy with a
  101-character description and an unknown transport type fails the same check.
- The DEPLOY.md curl smoke tests return 200 locally (SSE for legacy `initialize`, JSON for stateless
  `tools/list`).

## 8. Build process

Code, tests, README, DEPLOY, LICENSE and server.json were authored by Codex (OpenAI Codex CLI 0.162.1,
`codex exec -s workspace-write`, reasoning effort high) from written briefs. Claude was the pilot: doc
research, this file, the briefs, the ranking prototype, dependency installs, `wrangler types`, local D1,
`wrangler dev`, integration and eval runs, the full ingest, review, small doc edits and the commits.

Codex could not spawn child processes in its sandbox (`spawn EPERM`), so it could not run
`wrangler types` or Vitest's default fork pool; it ran Vitest with `--pool threads` and the pilot ran
everything else outside the sandbox.

## Codex run log

| Round | Model (from the exec header) | Session | Scope | Pilot findings sent back |
| --- | --- | --- | --- | --- |
| 1 | gpt-6-sol | 01a13b3a-dfd4-7050-a495-a1737ce80507 | Worker, tools, sanitizer, schema, ingest, build-sql, refresh, unit and integration tests, bench | null timestamps in the real corpus; node tsconfig errors with generated types; integration helper parsed error text as JSON; dense code style |
| 2 | gpt-6-sol | 01a13b51-efa2-7291-a8d2-7319eb940619 | Fixes above, README, DEPLOY, LICENSE, server.json, reformat | ranking problems on the full corpus; `#t-N-N` anchors |
| 3 | gpt-6-sol | 01a13b63-cfee-7861-a174-33b5e1470bff | Episode-aware ranking, duplicate collapsing, anchor resolution, eval script | none blocking |
