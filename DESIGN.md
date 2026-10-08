# @convex-dev/mcp — design

Goal: one component that turns any Convex app into a remote MCP server, so the
app's users can connect their agent (Claude, ChatGPT, Cursor, Claude Code, …)
and act on their own data in the app.

## Shape

```
 agent ──HTTP──▶ app http.ts (routes registered by McpServer client)
                   │  POST /mcp            JSON-RPC (Streamable HTTP, stateless)
                   │  /.well-known/oauth-protected-resource[/mcp]
                   │  /.well-known/oauth-authorization-server   (issuer = site origin)
                   │  POST /mcp/oauth/register   (RFC 7591 DCR)
                   │  GET  /mcp/oauth/authorize  → 302 to app consent page
                   │  POST /mcp/oauth/token      (code+PKCE, refresh rotation)
                   │  POST /mcp/oauth/revoke     (RFC 7009)
                   ▼
           tool handlers run in the app's httpAction ctx
           (runQuery/runMutation/runAction on the app's own functions,
            with the authenticated `userId` passed explicitly)
                   │
                   ▼
           components.mcp.*  — owns all auth state
             tables: clients, authRequests, grants, tokens
             child:  @convex-dev/rate-limiter (DCR, /authorize)
```

Why the routes live in the app (via `mcp.registerRoutes(http)`) and not in the
component's own `http.ts`:

- Tools are app code: they must call the app's queries/mutations. Running them
  inside the app's httpAction avoids a function-handle registry that has to be
  re-synced on every deploy.
- RFC 9728 / RFC 8414 discovery documents live at the origin root
  (`/.well-known/...`), which a component `httpPrefix` mount cannot reach.

The component is therefore pure state + logic: client registration, auth
requests, grants, token issue/rotate/verify/revoke, API keys, cleanup.

## Tool API

```ts
const mcp = new McpServer(components.mcp, {
  name: "Todos", version: "1.0.0",
  consentUrl: "https://app.example.com/connect",   // app page, user signed in
  tools: {
    list_todos: tool({
      description: "List the user's todos",
      args: { done: v.optional(v.boolean()) },
      annotations: { readOnlyHint: true },
      handler: (ctx, args, { userId }) =>
        ctx.runQuery(internal.todos.listForUser, { userId, ...args }),
    }),
  },
});
mcp.registerRoutes(http);
export const { getAuthRequest, authorize, listConnections, revokeConnection,
  createApiKey } = mcp.api({ getUserId: getAuthUserId /* or tokenIdentifier */ });
```

- `args` are Convex validators. The client converts them to JSON Schema for
  `tools/list` (`inputSchema`) and validates incoming arguments against the
  same validator JSON before calling the handler. Validation failures become
  `isError: true` tool results (so the model can self-correct), not JSON-RPC
  protocol errors.
- Optional `returns` validator → `outputSchema` + `structuredContent`, and
  enforced: a non-conforming result (incl. extra fields) becomes a generic
  tool error, so undeclared fields never leak.
- Handler return: string → text content; anything else → JSON text content
  (+ structuredContent when it's an object). Handlers may also return a full
  `CallToolResult`.
- Thrown `ConvexError` → `isError` result with its data; other errors →
  generic message (don't leak internals), logged.
- `userId` is always from the verified token; tool handlers never trust
  arguments for identity.

## Protocol

- **Dual-era.** Requests carrying `_meta["io.modelcontextprotocol/protocolVersion"]`
  use MCP 2026-07-28: no `initialize`, `server/discover`, required
  `MCP-Protocol-Version` / `Mcp-Method` / `Mcp-Name` headers that must match
  the body (`-32020`), `-32022` with the supported versions, `resultType` +
  `serverInfo` `_meta` on every result, `ttlMs`/`cacheScope` on lists
  (`private` for `tools/list`, which depends on the token's scopes), 404 for
  unknown methods. Other requests get the legacy behavior below.
- Streamable HTTP, **stateless**: no `Mcp-Session-Id`. Requests are answered
  with `application/json`; POSTs carrying only notifications/responses get
  `202` with no body. GET/DELETE `/mcp` → 405 (no server-initiated SSE).
- Methods: `initialize`, `notifications/initialized`, `ping`, `tools/list`,
  `tools/call`. Capabilities advertised: `tools` only.
- Protocol version negotiation: echo the client's version if supported
  (2025-03-26, 2025-06-18, 2025-11-25) else our latest. A missing
  `MCP-Protocol-Version` header means 2025-03-26; an unsupported one → 400.
- JSON-RPC batches accepted only for 2025-03-26.
- Credentials are checked before JSON-RPC dispatch: 401 with
  `WWW-Authenticate: Bearer resource_metadata=…`; a call outside the
  connection's scopes → 403 `insufficient_scope`.
- Origin header: if present must be in `allowedOrigins` (DNS-rebinding
  guidance); CORS headers for allowed origins.

## Auth

Two credential kinds, one `tokens` table (stores SHA-256 hash only):

1. **OAuth 2.1** (what claude.ai / ChatGPT connectors need)
   - DCR, public clients (`token_endpoint_auth_method: none`), PKCE S256
     required, exact redirect_uri match.
   - `/authorize` validates client + redirect, stores an `authRequest`
     (10 min TTL), redirects to `consentUrl?request=<id>`.
   - Client ID metadata documents (2025-11-25) only for allowlisted hosts:
     Convex `fetch` can't pin resolved IPs, so open CIMD would be an SSRF.
   - The app's consent page (user signed in with the app's own auth) calls
     `getAuthRequest` (client name, redirect host, scopes) and then
     `authorize({ approve })`, an **action** that generates the code and
     settles the request in one mutation:
     generates code, stores its hash bound to `{userId, client, PKCE
     challenge, redirect_uri, resource, scopes}`, returns the redirect URL
     the page navigates to.
   - `/token`: code (single use, 60 s TTL; PKCE verified) → access (1 h) +
     refresh (30 d, rotated each use). Rotated refresh tokens are kept as
     tombstones until they expire, so replaying *any* earlier generation
     revokes the whole grant.
   - Code consumption + issuance, and refresh validation + rotation, are
     each a single mutation.
   - Every authorization creates a new grant (same client on several machines
     = several connections).
   - RFC 8707 `resource` bound to tokens and checked against the server URL.
   - 401s carry `WWW-Authenticate: Bearer resource_metadata="…"`.
2. **API keys** (Claude Code / Cursor / scripts): `createApiKey` action
   returns the plaintext once; long-lived until revoked.

A **grant** row = one connection (user × client). `listConnections` /
`revoke` let the app render a "Connected agents" settings page; revoking a
grant kills all its tokens.

Secret generation happens in actions/httpActions (`crypto.getRandomValues`);
mutations only ever see hashes.

`lastUsedAt` on grants is updated at most once per minute to avoid write
contention on hot tokens. `tokens.verify` takes `now` as an argument: a query
reading `Date.now()` can be served from cache past a token's expiry.

DCR and `/authorize` are rate limited (global / per client). DCR clients
expire after 24 h unless they complete an authorization.

## Scopes

Optional. `tool({ scope: "write" })`; server advertises `scopesSupported`.
Tokens carry granted scopes; tools outside scope are hidden from `tools/list`
and rejected on call. Default: single implicit scope, all tools.

## Cleanup

Component cron hourly: delete expired authRequests/codes/tokens and unused
DCR clients in bounded batches, rescheduling itself while batches are full.

## Not in v1

- SSE streaming / progress notifications / server→client requests
  (sampling, elicitation) — need a long-lived connection.
- Resources & prompts (API leaves room: `resources:` / `prompts:` options).
- Open (non-allowlisted) Client ID Metadata Documents.
- Per-IP rate limiting; rate limiting of the MCP endpoint itself.
- Confidential clients with client secrets.

## Review log

Architecture and implementation were reviewed twice with Codex. Changes
made as a result: 202 for notifications and strict version-header handling;
a single coherent issuer; pre-dispatch 401/403 challenges; `now` passed into
token verification; multi-generation refresh replay detection; a grant per
authorization; `returns` enforcement; allowlist-only CIMD with a capped body
read; DCR/authorize rate limits and expiry of unused clients;
`tokenIdentifier`/users-table IDs instead of `subject`.
