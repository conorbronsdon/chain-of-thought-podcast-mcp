# Deployment notes

The `database_id` in `wrangler.jsonc` is a placeholder. Create `cot-archive` with `wrangler d1 create cot-archive` and replace the ID with the returned value before deploying. The full ingest SQL contains transcript text and must stay out of git.

The proposed production hostname is `mcp.chainofthought.show`. After its proxied DNS record exists, uncomment the zone route in `wrangler.jsonc`. The file explains why it uses a zone route instead of `custom_domain`. `MCP_HOSTNAMES` and `MCP_ORIGIN_HOSTNAMES` should match the deployed host and expected browser origins.

The current cached corpus contains invalid segment timing fields in episodes 5, 6, 7, and 9. Correct those at the source before generating and importing the full SQL file. The hourly refresh is enabled by default; set `REFRESH_ENABLED` to a value other than `true` to disable it.
