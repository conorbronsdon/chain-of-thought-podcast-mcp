# Chain of Thought archive MCP server

Read-only Streamable HTTP MCP server for searching and citing the [Chain of Thought podcast](https://chainofthought.show), hosted by Conor Bronsdon. It exposes `search_transcripts`, `search_episodes`, `get_episode`, and `get_transcript_excerpt` at `/mcp`. Cite the episode URLs in results, not the MCP endpoint. Transcripts are machine-generated; verify exact quotations against the recording.

## Local fixture

The source cache belongs in `.cache/corpus/` and is not committed. With the cached files and installed dependencies:

```sh
npm run build-sql:fixture
npm run db:fixture
npm run dev:fixture
```

In another terminal, run `npm run test:integration` or `npm run query -- search_transcripts '{"query":"agent memory"}'`.

`npm test` runs offline unit tests. `npm run typecheck` checks the worker, scripts, and tests. The integration suite requires a running local Worker with episodes 77, 38, and 2 loaded.

## Source-data validation

The SQL builder rejects segments whose `time` is not a string or whose `seconds` is not finite. The current cached corpus has null values in episodes 5, 6, 7, and 9, so a full `npm run build-sql -- --offline` stops until the source data is corrected. The three-episode fixture is valid.

See [DEPLOY.md](DEPLOY.md) for the D1 ID and route setup.
