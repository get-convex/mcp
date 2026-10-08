# Convex MCP

[![npm version](https://badge.fury.io/js/@convex-dev%2Fmcp.svg)](https://badge.fury.io/js/@convex-dev%2Fmcp)

<!-- START: Include on https://convex.dev/components -->

Let your users use your app from their AI agents. This component turns a
Convex app into a remote [MCP](https://modelcontextprotocol.io) server with
sign-in built in. Your users paste one URL into Claude, ChatGPT, Cursor or
Claude Code, approve the agent on a page in your app, and the agent can then
work with **their** data through tools you define.

```ts
export const mcp = new McpServer(components.mcp, {
  name: "todos",
  version: "1.0.0",
  consentUrl: `${process.env.SITE_URL}/connect`,
  tools: {
    add_todo: tool({
      description: "Add a todo for the user.",
      args: { text: v.string() },
      handler: (ctx, args, user) =>
        ctx.runMutation(internal.todos.add, { userId: user.userId, ...args }),
    }),
  },
});
```

- **Tools from Convex validators.** `args` and `returns` become JSON Schema
  (`inputSchema` / `outputSchema`). Bad arguments go back to the model as tool
  errors it can fix.
- **A full OAuth 2.1 authorization server.** It supports discovery (RFC 9728 /
  RFC 8414), dynamic client registration, PKCE, rotating refresh tokens with
  replay detection, and audience-bound tokens. It works with claude.ai
  connectors and any spec-compliant client. Client ID metadata documents are
  available as an opt-in for hosts you allowlist.
- **Your auth, your consent page.** Users sign in with whatever your app
  already uses (Convex Auth, Clerk, WorkOS, …), then approve the agent.
- **Connections UI.** Users can list connected agents, disconnect them, and
  create API keys for CLI agents.
- **Scopes.** You can let users connect a read-only agent.
- **Secrets are stored hashed.** Tokens are opaque and stored as SHA-256 only.
  Expired credentials and unused client registrations are cleaned up by a
  cron, and the unauthenticated endpoints are rate limited.

Supports MCP protocol versions 2025-11-25, 2025-06-18 and 2025-03-26 over
stateless Streamable HTTP.

Found a bug? Feature request?
[File it here](https://github.com/get-convex/mcp/issues).

## Installation

```sh
npm install @convex-dev/mcp
```

```ts
// convex/convex.config.ts
import { defineApp } from "convex/server";
import mcp from "@convex-dev/mcp/convex.config.js";

const app = defineApp();
app.use(mcp);
export default app;
```

> The MCP and OAuth discovery routes are served from your app's HTTP router
> at the origin root (`/.well-known/...`). Don't give the app itself an
> `httpPrefix`.

## Usage

### 1. Define the server and tools

Tool handlers run in an HTTP action. There's no `ctx.auth` identity there:
the verified user comes in as `user.userId`. Pass it to internal functions,
and check ownership there just like your UI code does.

```ts
// convex/mcp.ts
import { McpServer, tool } from "@convex-dev/mcp";
import { getAuthUserId } from "@convex-dev/auth/server";
import { v } from "convex/values";
import { components, internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";

export const mcp = new McpServer(components.mcp, {
  name: "todos",
  title: "Todos",
  version: "1.0.0",
  instructions: "Manage the user's todo list.",
  consentUrl: `${process.env.SITE_URL}/connect`,
  scopes: {
    "todos:read": "See your todos",
    "todos:write": "Add and complete your todos",
  },
  tools: {
    list_todos: tool({
      description: "List the user's todos, optionally filtered by completion.",
      args: { done: v.optional(v.boolean()) },
      returns: v.object({
        todos: v.array(v.object({ id: v.string(), text: v.string(), done: v.boolean() })),
      }),
      annotations: { readOnlyHint: true },
      scope: "todos:read",
      handler: async (ctx, args, user) => ({
        todos: await ctx.runQuery(internal.todos.listForUser, {
          userId: user.userId as Id<"users">,
          ...args,
        }),
      }),
    }),
  },
});

// Functions your frontend uses for the consent page and settings.
export const {
  getAuthRequest,
  authorize,
  listConnections,
  revokeConnection,
  createApiKey,
} = mcp.api({ getUserId: getAuthUserId });
```

`getUserId` decides who a connection acts for. Return a stable ID that can't
collide across identity providers, such as your users table ID or
`identity.tokenIdentifier`.

### 2. Register the routes

```ts
// convex/http.ts
import { httpRouter } from "convex/server";
import { mcp } from "./mcp";

const http = httpRouter();
mcp.registerRoutes(http);
export default http;
```

Your MCP server URL is `https://<deployment>.convex.site/mcp`. If you serve
HTTP actions from a custom domain, pass `siteUrl`.

Every authorization creates its own connection, so a user can connect the
same agent on several machines.

### 3. Add a consent page

When an agent connects, the user is sent to `consentUrl?request=<id>`. On
that page, make sure the user is signed in (coming back to the same URL
afterwards), show who's asking, and let them decide. Serve it with
`Content-Security-Policy: frame-ancestors 'none'` so it can't be framed.

```tsx
const requestId = new URLSearchParams(location.search).get("request")!;
const request = useQuery(api.mcp.getAuthRequest, { requestId });
const authorize = useAction(api.mcp.authorize);
// request: { clientName, redirectUri, scopes: [{ name, description }], status }

const decide = async (approve: boolean) => {
  const { redirectUrl } = await authorize({ requestId, approve });
  window.location.assign(redirectUrl); // back to the agent
};
```

### 4. Show connected agents

Settings can use `listConnections`, `revokeConnection({ id })` and
`createApiKey({ name })`. The API key is returned once. CLI agents use it as
a bearer token:

```sh
claude mcp add --transport http todos https://<deployment>.convex.site/mcp \
  --header "Authorization: Bearer <key>"
```

See [`example/`](./example) for a complete app with a consent page and a
connections UI.

### Tool results

- **Return values.** A string becomes text content. Any other value becomes
  JSON text content, plus `structuredContent` when `returns` is set and the
  value is an object. `bigint` values are encoded as strings and bytes as
  base64.
- **`returns` is enforced.** A result that doesn't match it, including one
  with extra fields, is logged and becomes a generic tool error. Nothing you
  didn't declare reaches the agent.
- **Full control.** Return `callToolResult({ content: [...], isError })` to
  shape the result yourself, for example to return images.
- **Errors.** Throw `ConvexError("…")` to send the model a message it can act
  on. Other errors are logged, and the model gets a generic failure.

### Scopes

Give a tool `scope: "x"` (it must be a key of `scopes`). A connection only
sees and can call tools in its granted scopes. A call outside those scopes
gets HTTP 403 `insufficient_scope`. When a client requests no scope, the
connection gets all of them.

## Designing your tools

This package ships an agent skill, `skills/convex-mcp`, that reads your app
and proposes a task-shaped tool surface (names, descriptions, args, scopes,
annotations) before wiring it up:

```sh
npx skills add get-convex/mcp
```

## Testing

```ts
import { convexTest } from "convex-test";
import mcpTest from "@convex-dev/mcp/test";

const t = convexTest(schema, modules);
mcpTest.register(t); // or mcpTest.register(t, "myMcp") for a custom name
const res = await t.fetch("/mcp", { method: "POST", headers: { Authorization: `Bearer ${apiKey}` }, body });
```

`register` also registers the bundled rate limiter. Set
`process.env.CONVEX_SITE_URL` in tests. See `example/convex/mcp.test.ts`.

## Limits and roadmap

- **Short tool calls.** Each tool call is a single HTTP action, so it has
  Convex's action time and memory limits. Keep calls short and return small
  results.
- **Not yet supported:** server-to-client streaming (SSE progress,
  sampling, elicitation), resources and prompts, and confidential clients.
- **Rate limiting.** Client registration and `/authorize` are rate limited
  through a bundled `@convex-dev/rate-limiter` instance. Limits are global or
  per client, not per IP. The MCP endpoint itself isn't rate limited yet.
- **Client ID metadata documents** are fetched from your backend, so they
  only work for hosts you list in `clientMetadataDocumentHosts`.

<!-- END: Include on https://convex.dev/components -->

## Development

```sh
npm i
npm run dev            # backend + rebuild on change
npm run dev:frontend   # example app at http://localhost:5173
node example/e2e.mjs   # end-to-end OAuth + MCP checks against the dev deployment
npm test && npm run lint && npm run typecheck
```

The example app uses Convex Auth. Set `JWT_PRIVATE_KEY`, `JWKS` and
`SITE_URL=http://localhost:5173` on the dev deployment
([guide](https://labs.convex.dev/auth/setup/manual)).
