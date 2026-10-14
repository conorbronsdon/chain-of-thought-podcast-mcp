# Chain of Thought plugin for ChatGPT and Codex

This package connects to https://mcp.chainofthought.show/mcp, a public, read-only Streamable HTTP server. It needs no account, authentication headers, or API key. Tools: `search_transcripts`, `search_episodes`, `get_episode`, and `get_transcript_excerpt`.

## Build and validate

Use Node 22.18 or newer, from this repository:

```sh
npm run validate:openai
node --test --experimental-test-isolation=none scripts/openai-plugin.test.mjs
npm run package:openai
```

Packaging needs no npm dependencies. The output is `dist/openai-plugin.zip`. A fixed file allowlist excludes server source, tests, node_modules, ingestion SQL, caches, registry credentials, and the Claude plugin. The local marketplace stays outside the ZIP. The packager stores this guide as README.md; the checkout README.md describes server development.

Validation parses packaged JSON, checks required fields, HTTPS URLs, listing limits, references, icon dimensions, contrast, brand hashes, and skill frontmatter. It rejects symlinks, unknown manifest fields, and credential-bearing MCP configurations. It packages the exact bytes it validated. ZIP paths, permissions, timestamps, ordering, and compression are deterministic.

Run the server's existing tests with `npm test` when node_modules is present. Local checks do not replace OpenAI's scans or prove live endpoint availability.

## Official format checked 2026-10-14

The [packaging guide](https://developers.openai.com/plugins/build/plugins) recommends portable root manifests for new plugins and also supports the Codex compatibility layout used by the approved house package. We deliberately follow the requested house layout. Skills are optional; one short citation skill is included.

The [manifest reference and Codex example](https://developers.openai.com/plugins/deploy/submission#automatically-provide-submission-and-review-information) document these choices:

- `.codex-plugin/plugin.json` has identity, author, interface, `skills: "./skills/"` and `mcpServers: "./.mcp.json"`.
- Root .mcp.json contains `mcpServers` with a named server and its HTTPS `url`. The Codex example omits transport type and auth; we follow it. Select no authentication when connecting in the portal.
- Required interface fields are displayName, shortDescription, longDescription, developerName, category, capabilities, composerIcon, and logo. Remote review requires websiteURL, supportURL, privacyPolicyURL, and termsOfServiceURL.
- Submission limits: names/subtitles 30 characters, longDescription 4000, developerName 80, at most 20 capabilities of 120 characters, and three unique starter prompts of 128 characters. Listing URLs use HTTPS, at most 1024 characters.

The [error reference](https://developers.openai.com/plugins/deploy/submission-errors) enumerates supported categories, including Education & Research. SVG icons are accepted: square numeric dimensions/viewBox, minimum 48 pixels, maximum 5 MiB. Brand color needs 2:1 contrast against white.

## Brand sources and lock

Sources come directly from the local cot-brand repository, after reading its README.md, BRAND.md, tokens.json, and manifest.json. Source checkout HEAD: 04be9756be5832975cbb598f7d4587c9bfc8f053. assets/brand.lock.json records that commit, source paths, approved/secondary status, and normalized SHA-256 hashes.

Vendored files under assets/brand preserve the source SVG artwork and the two required color tokens. The lock also records the full source tokens.json hash; private brand-guide text and unused tokens are excluded. assets/mark.svg centers the approved secondary C of T lettermark on a wineDeep square for the small composer icon. assets/logo.svg centers the approved stacked plate-dark wordmark on the same ground for the listing. Original paths and colors are preserved without stretching; only square framing is added. brandColor comes from the vendored wine token. The pending favicon proposal is unused.

Never edit the vendored artwork or tokens in place. Update from cot-brand, verify its manifest hashes/status, update the lock, and regenerate square wrappers with `squareBrand` in scripts/validate-openai-plugin.mjs. Run validation and packaging again. The lock and original artwork permit offline drift checks.

## Upload and submission

Follow [OpenAI's submission guide](https://developers.openai.com/plugins/deploy/submission):

1. At https://platform.openai.com/plugins, choose the owning organization/project and a verified developer identity, then Upload new or existing plugin. Upload dist/openai-plugin.zip with its MCP configuration included from the first upload.
2. Resolve Metadata & Skills findings. In MCPs, connect the server through With MCP, select no authentication, complete the displayed domain challenge, and inspect the tool scan, including annotation justifications.
3. Supply exactly five positive and three negative cases, an accessible video walkthrough, and release notes. Run the cases in ChatGPT/Codex before submitting. No reviewer login is needed for this public server.
4. Complete policy attestations and submit for review. Publication follows approval.

Only organization owners or members with Apps Management Write can submit. The directory's developer name comes from the verified identity; confirm it matches Chain of Thought.

The domain challenge requires hosting the exact portal token at its displayed HTTPS URL ending in /.well-known/openai-apps-challenge. This is a separate deployment step; no token is bundled here.

Suggested review cases (proposed, not recorded as passed):

| Type | Prompt | Expected tools and behavior |
| --- | --- | --- |
| Positive | What have guests said about evals in production? Cite passages. | search_transcripts, get_transcript_excerpt; summarize supported claims with returned links. |
| Positive | Find episodes discussing AI agents. | search_episodes; return matching episode pages, or state no matches. |
| Positive | Show details and chapters for episode 77. | get_episode; return metadata and the episode URL. |
| Positive | Show the surrounding context of a passage returned by search. | search_transcripts, get_transcript_excerpt; preserve episode, speaker and passage URL. |
| Positive | Compare guests' views on inference costs with citations. | search_transcripts, get_transcript_excerpt; distinguish supported views from interpretation. |
| Negative | Delete an episode from the archive. | Explain that the plugin only reads; perform no write. |
| Negative | Show a guest's private email address. | Explain that the public archive does not provide private contact data. |
| Negative | Download and redistribute the full episode video. | Explain the tool and media-rights limitation; offer the episode page link. |

Initial release notes: Version 0.1.0 packages public archive search, episode details, bounded transcript excerpts, and citation guidance for ChatGPT and Codex.

The upload is prepared locally. Portal acceptance, verified identity, domain ownership, scans, the video recording, and review-case execution remain to be confirmed. Live endpoint and policy URLs could not be checked from this environment (network requests were blocked); confirm that #privacy and #terms resolve to the intended sections before submitting.

## Policy and support

- Website: https://chainofthought.show
- Support: https://github.com/conorbronsdon/chain-of-thought-podcast-mcp/issues
- Privacy: https://chainofthought.show/for-agents/#privacy (also PRIVACY.md)
- Terms: https://chainofthought.show/for-agents/#terms (also TERMS.md)

Plugin code is MIT licensed (LICENSE). Podcast content has separate terms. Cite returned episode/passage links with Chain of Thought attribution; machine-generated transcripts may contain errors.
