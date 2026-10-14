# Security policy

This is a public, read-only MCP server (https://mcp.chainofthought.show/mcp) that serves published podcast transcripts and episode metadata. It has no accounts, credentials or user data, but it is still in scope for security reports: rate-limit bypasses, injection through tool arguments, cache or data-store tampering, and anything that lets a request change server state.

## Reporting a vulnerability

Report privately through GitHub's **Report a vulnerability** button on this repository's Security tab (private vulnerability reporting is enabled). Please don't open a public issue for a security problem.

You can expect an acknowledgement within a few days. Fixes are deployed to the live endpoint directly; there are no versioned releases to patch.
