# @convex-dev/mcp — design

Goal: one component that turns any Convex app into a remote MCP server, so the
app's users can connect their agent (Claude, ChatGPT, Cursor, Claude Code, …)
and act on their own data in the app.

## Shape

```
 agent ──HTTP──▶ app http.ts (routes registered by McpServer client)
                   │  POST /mcp            JSON-RPC (Streamable HTTP, stateless)
                   │  /.well-known/oauth-protected-resource[/mcp]
                   │  /.well-known/oauth-authorization-server[/mcp]
                   │  /mcp/.well-known/openid-configuration
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
export const { getAuthRequest, approve, deny, listConnections, revoke,
  createApiKey } = mcp.api({ getUserId: async (ctx) => (await ctx.auth.getUserIdentity())?.subject ?? null });
```

- `args` are Convex validators. The client converts them to JSON Schema for
  `tools/list` (`inputSchema`) and validates incoming arguments against the
  same validator JSON before calling the handler. Validation failures become
  `isError: true` tool results (so the model can self-correct), not JSON-RPC
  protocol errors.
- Optional `returns` validator → `outputSchema` + `structuredContent`.
- Handler return: string → text content; anything else → JSON text content
  (+ structuredContent when it's an object). Handlers may also return a full
  `CallToolResult`.
- Thrown `ConvexError` → `isError` result with its data; other errors →
  generic message (don't leak internals), logged.
- `userId` is always from the verified token; tool handlers never trust
  arguments for identity.

## Protocol

- Streamable HTTP, **stateless**: no `Mcp-Session-Id`, every POST answered with
  `application/json`. GET/DELETE `/mcp` → 405 (no server-initiated SSE).
- Methods: `initialize`, `notifications/initialized`, `ping`, `tools/list`,
  `tools/call`. Capabilities advertised: `tools` only.
- Protocol version negotiation: echo the client's version if supported
  (2025-03-26, 2025-06-18, 2025-11-25) else our latest. `MCP-Protocol-Version`
  header checked when present.
- JSON-RPC batches accepted for 2025-03-26 compatibility.
- Origin header: if present must be in `allowedOrigins` (DNS-rebinding
  guidance); CORS headers for allowed origins.

## Auth

Two credential kinds, one `tokens` table (stores SHA-256 hash only):

1. **OAuth 2.1** (what claude.ai / ChatGPT connectors need)
   - DCR, public clients (`token_endpoint_auth_method: none`), PKCE S256
     required, exact redirect_uri match.
   - `/authorize` validates client + redirect, stores an `authRequest`
     (10 min TTL), redirects to `consentUrl?request=<id>`.
   - The app's consent page (user signed in with the app's own auth) calls
     `getAuthRequest` (client name, redirect host, scopes) and then
     `approve`/`deny`. `approve` is an **action** (needs real randomness):
     generates code, stores its hash bound to `{userId, client, PKCE
     challenge, redirect_uri, resource, scopes}`, returns the redirect URL
     the page navigates to.
   - `/token`: code (single use, 60 s TTL; PKCE verified) → access (1 h) +
     refresh (30 d, rotated each use; reuse of a rotated refresh token revokes
     the whole grant).
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
contention on hot tokens.

## Scopes

Optional. `tool({ scope: "write" })`; server advertises `scopesSupported`.
Tokens carry granted scopes; tools outside scope are hidden from `tools/list`
and rejected on call. Default: single implicit scope, all tools.

## Cleanup

Component cron hourly: delete expired authRequests/codes/tokens in bounded
batches.

## Not in v1

- SSE streaming / progress notifications / server→client requests
  (sampling, elicitation) — need a long-lived connection.
- Resources & prompts (API leaves room: `resources:` / `prompts:` options).
- Client ID Metadata Documents (2025-11-25) — DCR covers current clients.
- Confidential clients with client secrets.
