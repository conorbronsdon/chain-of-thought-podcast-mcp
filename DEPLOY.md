# Deploying

These steps are for Conor. Nothing here has been run yet. Run them in order.

0. **Publish the repo after review.**

   ```sh
   gh repo create conorbronsdon/chain-of-thought-podcast-mcp --public --source . --push
   ```

1. **Install dependencies and log in to Cloudflare.**

   ```sh
   npm ci
   npx wrangler login
   npx wrangler whoami
   ```

2. **Create D1.**

   ```sh
   npx wrangler d1 create cot-archive
   ```

   Copy the returned `database_id` into `wrangler.jsonc`, replacing the zero placeholder. Then run `npm run types` and commit the configuration and generated types.

3. **Load the archive.**

   ```sh
   npm run build-sql
   npx wrangler d1 execute cot-archive --remote --file dist/ingest.sql
   npx wrangler d1 execute cot-archive --remote --command "SELECT (SELECT count(*) FROM episodes) AS episodes, (SELECT count(*) FROM segments) AS segments"
   ```

   Expect 77 episodes and 8,537 segments, the counts in `corpus.json` as of 2026-10-14.

   Rows written: measured against local D1 on 2026-10-14, the first full ingest wrote 8,715 rows and a re-run over a loaded database wrote 17,235 (the per-episode deletes count too). The local counter does not include FTS index writes; the two FTS indexes hold about 9,550 rows, so expect roughly 18,000 to 37,000 rows written per full ingest in production. The Free plan allows 100,000 D1 rows written per day and, since 2026-09-01, fails queries after that, so avoid repeating this step many times in one day. The database's metrics in the Cloudflare dashboard show the actual rows written afterwards.

   The SQL file contains transcript text in `dist/`; do not commit or publish it.

4. **Deploy the Worker.**

   ```sh
   npx wrangler deploy
   ```

   Test `/health` and `/` on the `workers.dev` URL printed by Wrangler.

5. **Attach the hostname.** In the Cloudflare dashboard for `chainofthought.show`, add a proxied DNS record: type `AAAA`, name `mcp`, value `100::`. Uncomment the `routes` entry in `wrangler.jsonc`, then run `npx wrangler deploy` again. The planned zone route avoids the `custom_domain` code 100117 failure seen when a DNS record already exists for a hostname. No record exists for `mcp.` today, so a Custom Domain would also work. [Cloudflare's routes page](https://developers.cloudflare.com/workers/configuration/routing/routes/) recommends Custom Domains over `100::` records. After routing works, you can set `"workers_dev": false` and redeploy.

6. **Smoke test the public endpoint.**

   ```sh
   curl https://mcp.chainofthought.show/health
   curl -i https://mcp.chainofthought.show/mcp -H "Content-Type: application/json" -H "Accept: application/json, text/event-stream" --data '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"curl","version":"1.0"}}}'
   curl -i https://mcp.chainofthought.show/mcp -H "Content-Type: application/json" -H "Accept: application/json, text/event-stream" -H "MCP-Protocol-Version: 2026-07-28" -H "Mcp-Method: tools/list" --data '{"jsonrpc":"2.0","id":2,"method":"tools/list","params":{"_meta":{"io.modelcontextprotocol/protocolVersion":"2026-07-28","io.modelcontextprotocol/clientCapabilities":{},"io.modelcontextprotocol/clientInfo":{"name":"curl","version":"1.0"}}}}'
   npm run query -- --url https://mcp.chainofthought.show/mcp --top 3 --compact search_transcripts '{"query":"portable agent memory"}'
   claude mcp add --transport http chain-of-thought https://mcp.chainofthought.show/mcp
   claude mcp list
   ```

   Both curl requests were checked against `wrangler dev --local` on 2026-10-14. The first (legacy `initialize`) answers 200 with an SSE `event: message` carrying `serverInfo.name` `chain-of-thought-podcast`; the second (stateless 2026-07-28 `tools/list`) answers 200 with JSON listing four tools. A request with a browser `Origin` from another site gets 403, and `GET /mcp` gets 405; both are expected.

7. **Check the cron.** Run `npx wrangler tail` around minute 23 of the hour, or inspect state with:

   ```sh
   npx wrangler d1 execute cot-archive --remote --command "SELECT key, value FROM meta"
   ```

   The Free plan allows five cron triggers per account. To stop refreshes, set `REFRESH_ENABLED` to `"false"` and deploy. A manual full refresh repeats step 3; the import is idempotent.

8. **Consider rate limiting.** A Free zone plan allows one WAF rate limiting rule, counted per IP with a 10-second period and 10-second mitigation timeout. Its expression can match the `/mcp` path using Path and Verified Bot fields. The commented Workers rate limit binding in `wrangler.jsonc` is another option after confirming support for this account; the Worker code would also need to call it.

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

   Then:

   ```sh
   mcp-publisher login github
   mcp-publisher publish
   curl "https://registry.modelcontextprotocol.io/v0.1/servers?search=io.github.conorbronsdon/chain-of-thought-podcast-mcp"
   ```

   GitHub login uses a device flow at `https://github.com/login/device`. The registry checks the `io.github.conorbronsdon/` namespace, not the remote URL. Its `description` limit is 100 characters.

10. **List in directories.** [Glama](https://glama.ai/mcp/faq) requires manual submission: Add MCP Server > Connector, then provide a name, description and HTTPS Streamable HTTP URL. Only healthy connectors are indexed for search; claiming the listing proves control. If linked to the official MCP Registry, registry updates replace Glama's name, description and URL by default. [Smithery](https://smithery.ai/docs/build/publish) also requires manual submission at `smithery.ai/new` with the public HTTPS URL, or `smithery mcp publish "https://mcp.chainofthought.show/mcp" -n @<org>/<name>`; public servers are scanned for tools. [PulseMCP](https://www.pulsemcp.com/submit) had paused submissions on 2026-10-14 and says it will pick up official registry entries automatically when submissions reopen. No reopening date was given.

11. **Roll back if needed.** Run `npx wrangler rollback`. Remove the route or set the DNS record to DNS only to stop routing the hostname to the Worker.

12. **Rebuild for backup recovery.** D1 export does not support databases containing FTS virtual tables. The corpus is the source of truth, so rebuild by repeating step 3.
