# Changelog

## 0.1.0-alpha.6

- Agent guide (`GET /mcp`): request all needed scopes in one approval (omit
  `scope` for all), use the device link right away even when the server is
  also configured but not signed in in the MCP client, and how to recover
  from 403 `insufficient_scope`.

## 0.1.0-alpha.5

- Device approvals require the confirmed code:
  `authorize({ requestId, approve: true, userCode })`. A consent page that
  doesn't show and confirm the code can't approve device requests (clear
  error), so forgetting that step fails closed.

## 0.1.0-alpha.4

- Paste the URL into any agent chat: `GET /mcp` returns agent-readable
  instructions, and agents with only an HTTP tool sign in with the OAuth
  device flow (RFC 8628, public client `mcp-agent`) — a clickable approval
  link plus a code to confirm, then a short-lived access token (no refresh
  token).
- Consent API: `getAuthRequest` returns `kind` and `userCode`;
  `authorize` returns `redirectUrl: null` for device requests; new
  `findAuthRequest({ userCode })` for typed codes (rate limited).
- Options: `deviceFlow` (default true), `describeTools` (default false).

## 0.1.0-alpha.3

- Typed user IDs: `createTool<Id<"users">>()` and `McpServer<UserId>`, so
  handlers need no casts.
- `vMcpUser()` validator to pass the whole MCP user (incl. connection scopes)
  into internal functions, so app authorization can narrow per connection.
- `mcp.lint()` flags risky setups (no scopes, missing annotations, scope
  mixups) and logs once on the first request (`warnings: false` to silence).
- README: Authorization recipes (own helper, sharing components, external
  engines) and a Security checklist; audit-my-server prompt.
- Example is now a sharing app (lists with viewer/editor members) with one
  access helper used by both the UI and the MCP tools.

## 0.1.0-alpha.2

- `mcp.internalApi()` with `createApiKeyForUser`: mint API keys from the CLI
  or tests (`npx convex run`), callable only with deploy credentials.
- Docs and skills: Convex Auth v2 import path (`@convex-dev/auth/core`),
  explicit `consentUrl` vs `siteUrl`, a framing fallback for static hosts,
  package-manager-neutral install, and a shared-items/roles access pattern.

## 0.1.0-alpha.1

- First release published from CI (npm trusted publishing).

## 0.1.0-alpha.0

- First alpha: MCP server for Convex apps with a built-in OAuth 2.1
  authorization server, tools defined with Convex validators, scopes,
  connections and API keys, and agent skills for tool design and security
  audits.
- MCP protocol 2026-07-28 plus 2025-11-25, 2025-06-18 and 2025-03-26.
