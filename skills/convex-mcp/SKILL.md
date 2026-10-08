---
name: convex-mcp
description: Design and add an MCP server to a Convex app with @convex-dev/mcp, so the app's users can use it from Claude, ChatGPT, Cursor or any agent. Reads the app, proposes a task-shaped tool surface (names, descriptions, args, scopes, annotations) for the user to approve, then wires the component, consent page and tools and verifies them. TRIGGER when the user wants their app usable from AI agents, an MCP server / connector / "Claude integration" for their app, or asks which MCP tools their app should expose. SKIP when there is no convex/ directory, or the user wants their agent to consume someone else's MCP server.
---

# Add an MCP server to a Convex app

`@convex-dev/mcp` turns a Convex app into a remote MCP server with OAuth
built in. Users paste `https://<deployment>.convex.site/mcp` into their agent,
sign in to the app on a consent page, and the agent can then call tools that
act on **their** data.

The component handles protocol and auth. Your job is the part that decides
whether agents are actually good at using the app: **the tool surface**.

## Workflow

1. **Understand the app.** Read `convex/schema.ts`, the public functions, and
   the auth setup. Write down: who the user is (`getAuthUserId`, Clerk
   `tokenIdentifier`, …), the core objects, and the 5-10 things a user does
   most. Note how ownership is enforced today.
2. **Propose the tool surface before writing code.** Use
   [references/tool-design.md](references/tool-design.md). Present a table:
   tool name · one-line description · args · read/write · scope ·
   annotations, plus what you deliberately left out and why. Get the user's
   OK; adjust.
3. **Install and wire** (see "Wiring" below): `npm i @convex-dev/mcp`,
   `app.use(mcp)`, `convex/mcp.ts`, `http.ts`, a `/connect` consent page,
   and a "Connected agents" section in settings.
4. **Implement tools on internal functions that take `userId`.** Reuse the
   app's existing helpers and ownership checks; never trust IDs from the
   model without checking they belong to `userId`.
5. **Verify.** `npx convex dev --once` + typecheck, then exercise the real
   endpoint: create an API key through the app, `tools/list`, and call every
   tool once (see "Verify"). Fix descriptions the model would misread.

## Wiring

```ts
// convex/convex.config.ts
import mcp from "@convex-dev/mcp/convex.config.js";
app.use(mcp); // the app itself must not set an httpPrefix
```

```ts
// convex/mcp.ts
import { McpServer, tool } from "@convex-dev/mcp";
import { getAuthUserId } from "@convex-dev/auth/server";
import { v } from "convex/values";
import { components, internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";

export const mcp = new McpServer(components.mcp, {
  name: "acme", title: "Acme", version: "1.0.0",
  instructions: "Short guidance on how the tools fit together.",
  consentUrl: `${process.env.SITE_URL}/connect`,
  scopes: { "docs:read": "Read your documents", "docs:write": "Create and edit your documents" },
  tools: {
    search_documents: tool({
      description: "Search the user's documents by title and content. Returns up to `limit` matches, newest first.",
      args: { query: v.string(), limit: v.optional(v.number()) },
      returns: v.object({ documents: v.array(v.object({ id: v.string(), title: v.string(), snippet: v.string() })) }),
      annotations: { readOnlyHint: true },
      scope: "docs:read",
      handler: async (ctx, args, user) => ({
        documents: await ctx.runQuery(internal.documents.searchForUser, {
          userId: user.userId as Id<"users">, ...args,
        }),
      }),
    }),
  },
});

export const { getAuthRequest, authorize, listConnections, revokeConnection, createApiKey } =
  mcp.api({ getUserId: getAuthUserId });
```

```ts
// convex/http.ts
mcp.registerRoutes(http); // /mcp, /mcp/oauth/*, /.well-known/*
```

- `getUserId` must return a **stable, unique** user ID: the users-table ID
  (Convex Auth `getAuthUserId`) or `identity.tokenIdentifier`. Never
  `identity.subject` alone with multiple issuers, never an email.
- Tool handlers run in an HTTP action: there is **no `ctx.auth` identity**.
  Identity arrives only as `user.userId`. Call internal functions with it.
- `SITE_URL` (env) is the app's frontend origin. Behind a custom API domain,
  pass `siteUrl` to `McpServer`.
- Consent page at `/connect?request=…`: if signed out, sign in and come back
  to the same URL; show `getAuthRequest` (client name, scopes, redirect
  host); Allow/Deny call `authorize({ requestId, approve })` and
  `window.location.assign(redirectUrl)`.
- Settings: show the MCP URL, `listConnections` with "Disconnect"
  (`revokeConnection`), and "Create API key" (`createApiKey`, show once) for
  CLI agents: `claude mcp add --transport http acme <url> --header "Authorization: Bearer <key>"`.

The package's `example/` directory is a complete reference (todos app,
consent page, connections UI, `example/e2e.mjs` end-to-end script).

## Verify

```sh
KEY=...   # from createApiKey in the app UI or `npx convex run`-driven test
curl -s $SITE/mcp -H "Authorization: Bearer $KEY" -H 'Content-Type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'
```

Call each tool once with realistic arguments and once with a bad ID owned by
nobody (expect an `isError` result, not a crash). For a full OAuth check,
connect the MCP Inspector (`npx @modelcontextprotocol/inspector`) or Claude
to the URL.

## Don'ts

- Don't take `userId`, `ownerId`, `orgId`-you-didn't-verify, or an email as a
  tool argument to decide whose data to touch.
- Don't expose `internal*` admin functions, cross-user queries, or billing
  mutations as tools without the user explicitly asking.
- Don't return whole documents with internal fields (tokens, hashes,
  `_creationTime` noise); shape results for the model.
- Don't mirror every query/mutation 1:1. See the design guide.
