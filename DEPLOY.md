# Deploying and operating

`https://mcp.chainofthought.show/mcp` is live (since `e41ea28`). This file is the runbook for the launched server:

- **[Operations](#operations)**: what you run again, such as deploying a change, smoke testing, checking the cron, re-ingesting, rolling back, and the OpenAI domain challenge.
- **[One-time setup](#one-time-setup)**: how the server was stood up, kept so it can be rebuilt from scratch. Don't re-run these steps against the live setup.

All commands run from the repo root after `npm ci`, logged in with `npx wrangler login` (check with `npx wrangler whoami`). Production is the Worker `cot-archive-mcp` on the zone route `mcp.chainofthought.show/*`, with D1 database `cot-archive` (both in `wrangler.jsonc`).

## Operations

### Deploy a code change

```sh
npm ci
npm run typecheck && npm test
npx wrangler deploy
```

Then run the [smoke test](#smoke-test). Keep `workers_dev` set to `false` and `ALLOW_WORKERS_DEV` set to `"false"` in `wrangler.jsonc`. A `workers.dev` hostname bypasses the zone's WAF rate rule, so the Worker returns 404 there unless `ALLOW_WORKERS_DEV` is explicitly `"true"`.

### Smoke test

Run after every deploy. To test a local build first, use `http://127.0.0.1:8787` with `npm run dev:fixture` instead.

```sh
curl https://mcp.chainofthought.show/health
curl https://mcp.chainofthought.show/
curl -i https://mcp.chainofthought.show/mcp -H "Content-Type: application/json" -H "Accept: application/json, text/event-stream" --data '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"curl","version":"1.0"}}}'
curl -i https://mcp.chainofthought.show/mcp -H "Content-Type: application/json" -H "Accept: application/json, text/event-stream" -H "MCP-Protocol-Version: 2026-07-28" -H "Mcp-Method: tools/list" --data '{"jsonrpc":"2.0","id":2,"method":"tools/list","params":{"_meta":{"io.modelcontextprotocol/protocolVersion":"2026-07-28","io.modelcontextprotocol/clientCapabilities":{},"io.modelcontextprotocol/clientInfo":{"name":"curl","version":"1.0"}}}}'
npm run query -- --url https://mcp.chainofthought.show/mcp --top 3 --compact search_transcripts '{"query":"portable agent memory"}'
```

Expected results:

- `/health` returns `ok`.
- `/` returns the server description.
- The legacy `initialize` request answers 200 with an SSE `event: message` carrying `serverInfo.name` `chain-of-thought-podcast`.
- The stateless 2026-07-28 `tools/list` answers 200 with JSON listing four tools.
- `npm run query` prints ranked passages.

Two other responses are also expected: a request with a browser `Origin` from another site gets 403, and `GET /mcp` gets 405.

To check from a client as well:

```sh
claude mcp add --transport http chain-of-thought https://mcp.chainofthought.show/mcp
claude mcp list
```

### Check the cron

An hourly cron (`23 * * * *`) adds, changes or removes at most one episode per run. Run `npx wrangler tail` around minute 23 of the hour, or inspect state with:

```sh
npx wrangler d1 execute cot-archive --remote --command "SELECT key, value FROM meta"
```

To confirm the cron is keeping up, compare the live counts with the corpus manifest. `corpus.json` `counts` is the source of truth, so read the numbers from there instead of expecting a fixed number:

```sh
curl -s https://chainofthought.show/corpus.json | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(JSON.parse(s).counts))'
npx wrangler d1 execute cot-archive --remote --command "SELECT (SELECT count(*) FROM episodes) AS episodes, (SELECT count(*) FROM segments) AS segments"
```

`episodes` and `segments` should equal `counts.episodes` and `counts.segments`. Right after a new episode is published they can lag by about an hour per changed episode.

To stop refreshes, set `REFRESH_ENABLED` to `"false"` in `wrangler.jsonc` and deploy. The Free plan allows five cron triggers per account.

### Re-ingest the full archive

Use this to recover from a bad refresh, to apply schema changes, or to [rebuild](#rebuild-from-scratch). The import is idempotent.

```sh
npm run build-sql
npx wrangler d1 execute cot-archive --remote --file dist/ingest.sql
```

Then run the count check from [Check the cron](#check-the-cron). The counts should match `corpus.json` immediately.

**Row-write budget.** Rows written scale with corpus size. On 2026-10-14, with 8,537 segments, a first full ingest into an empty local D1 wrote 8,715 rows, and a re-run over a loaded database wrote 17,235 (the per-episode deletes count too). The local counter leaves out FTS index writes, which add roughly one more row per segment. So expect about 2× to 4× the current `counts.segments` in rows written per full ingest. The Free plan allows 100,000 D1 rows written per day and, since 2026-09-01, fails queries after that, so don't repeat a full ingest many times in one day. The database's metrics in the Cloudflare dashboard show the actual rows written.

`dist/ingest.sql` contains transcript text. Do not commit or publish it.

### Roll back

```sh
npx wrangler rollback
```

To stop routing the hostname to the Worker entirely, remove the route or set the `mcp` DNS record to DNS only.

### Rebuild from scratch

D1 export does not support databases containing FTS virtual tables, so there is no D1 backup to restore. The corpus is the source of truth: [re-ingest](#re-ingest-the-full-archive) into the existing database, or into a new one created as in setup step 2.

### OpenAI app-directory domain challenge

`GET /.well-known/openai-apps-challenge` returns the `OPENAI_APPS_CHALLENGE` Worker secret, and returns 404 when the secret is unset (`src/index.ts`). When the OpenAI platform portal shows a domain challenge token (see [OPENAI_PLUGIN.md](OPENAI_PLUGIN.md#upload-and-submission)):

```sh
npx wrangler secret put OPENAI_APPS_CHALLENGE   # paste the exact portal token
curl https://mcp.chainofthought.show/.well-known/openai-apps-challenge
```

The curl should print the token. Then complete the challenge in the portal. `wrangler secret put` deploys a new Worker version with the secret, so you don't need a separate `wrangler deploy`.

Once the portal shows the domain as verified, remove the secret so the route goes back to 404, unless the portal says the token must stay in place for re-checks:

```sh
npx wrangler secret delete OPENAI_APPS_CHALLENGE
```

### Update the MCP Registry entry

The registry entry comes from `server.json`. After changing it, bump `version`, then:

```sh
mcp-publisher login github
mcp-publisher publish
curl "https://registry.modelcontextprotocol.io/v0.1/servers?search=io.github.conorbronsdon/chain-of-thought-podcast-mcp"
```

See setup step 9 to install `mcp-publisher`.

## One-time setup

These steps stood up the live server. Status is as of 2026-11-03. "Confirmed" means it was checked from outside: the repo, the endpoint or a public registry. "Conor to confirm" means it can only be checked in a dashboard.

| Step | Status |
| --- | --- |
| 0. Publish the repo | Done: the public repo exists. |
| 1. Install dependencies and log in to Cloudflare | Done (per machine; see the top of this file). |
| 2. Create D1 | Done: `wrangler.jsonc` has the real `database_id`. |
| 3. First load of the archive | Done: the live endpoint serves the corpus. Later loads: [Re-ingest](#re-ingest-the-full-archive). |
| 4. Create the `mcp` hostname | Done: `mcp.chainofthought.show` resolves to the Worker. |
| 5. First deploy | Done: `/health` returns `ok`. Later deploys: [Deploy a code change](#deploy-a-code-change). |
| 6. Smoke test | Recurring: [Smoke test](#smoke-test). |
| 7. Check the cron | Recurring: [Check the cron](#check-the-cron). |
| 8. WAF rate limiting rule | Conor to confirm in the Cloudflare dashboard. |
| 9. Publish to the MCP Registry | Done: the registry search returns `io.github.conorbronsdon/chain-of-thought-podcast-mcp`. Updates: [Update the MCP Registry entry](#update-the-mcp-registry-entry). |
| 10. List in directories (Glama, Smithery, PulseMCP) | Conor to confirm. |
| 11–12. Roll back, rebuild | Recurring: [Roll back](#roll-back), [Rebuild from scratch](#rebuild-from-scratch). |

The details below are kept for rebuilding in a new account or zone.

0. **Publish the repo.** `gh repo create conorbronsdon/chain-of-thought-podcast-mcp --public --source . --push`. Done; don't re-run.

2. **Create D1.** `npx wrangler d1 create cot-archive`, copy the returned `database_id` into `wrangler.jsonc`, then run `npm run types` and commit the configuration and generated types. Only repeat this for a new database. A new `database_id` replaces the current one.

4. **Create the hostname.** In the Cloudflare dashboard for `chainofthought.show`, add a proxied DNS record: type `AAAA`, name `mcp`, value `100::`. The zone route for `mcp.chainofthought.show/*` is in `wrangler.jsonc`. The route avoids the `custom_domain` code 100117 failure seen when a DNS record already exists for the hostname. [Cloudflare's routes page](https://developers.cloudflare.com/workers/configuration/routing/routes/) recommends Custom Domains over `100::` records.

8. **WAF rate limiting rule.** In the `chainofthought.show` zone, create the Free plan's one rate limiting rule with expression `(http.request.uri.path eq "/mcp")`, counting **per IP address**, threshold **10 requests per 10 seconds**, and mitigation **Block for 10 seconds**. Enable it and verify it applies to `mcp.chainofthought.show`. A request can still consume D1 reads, and the 5-million-row daily read limit causes an outage when reached. The Worker also rejects batches and oversized bodies, bounds search candidates, and caches repeated tool results, but the WAF rule limits distinct queries from one IP.

9. **Publish to the MCP Registry.** Install `mcp-publisher` using one of these commands, then authenticate and publish from the repo root, which holds `server.json`.

   macOS with Homebrew:

   ```sh
   brew install mcp-publisher
   ```

   Windows PowerShell:

   ```powershell
   $arch = if ([System.Runtime.InteropServices.RuntimeInformation]::ProcessArchitecture -eq "Arm64") { "arm64" } else { "amd64" }; Invoke-WebRequest -Uri "https://github.com/modelcontextprotocol/registry/releases/latest/download/mcp-publisher_windows_$arch.tar.gz" -OutFile "mcp-publisher.tar.gz"; tar xf mcp-publisher.tar.gz mcp-publisher.exe; rm mcp-publisher.tar.gz
   ```

   macOS or Linux:

   ```sh
   curl -L "https://github.com/modelcontextprotocol/registry/releases/latest/download/mcp-publisher_$(uname -s | tr '[:upper:]' '[:lower:]')_$(uname -m | sed 's/x86_64/amd64/;s/aarch64/arm64/').tar.gz" | tar xz mcp-publisher && sudo mv mcp-publisher /usr/local/bin/
   ```

   GitHub login uses a device flow at `https://github.com/login/device`. The registry checks the `io.github.conorbronsdon/` namespace, not the remote URL. Its `description` limit is 100 characters.

10. **List in directories.** [Glama](https://glama.ai/mcp/faq) requires manual submission: Add MCP Server > Connector, then provide a name, description and HTTPS Streamable HTTP URL. Only healthy connectors are indexed for search, and claiming the listing proves control. If the listing is linked to the official MCP Registry, registry updates replace Glama's name, description and URL by default. [Smithery](https://smithery.ai/docs/build/publish) also requires manual submission at `smithery.ai/new` with the public HTTPS URL, or `smithery mcp publish "https://mcp.chainofthought.show/mcp" -n @<org>/<name>`. Public servers are scanned for tools. [PulseMCP](https://www.pulsemcp.com/submit) had paused submissions on 2026-10-14 and says it will pick up official registry entries automatically when submissions reopen.
