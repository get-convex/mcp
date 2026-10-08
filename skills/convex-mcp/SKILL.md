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
3. **Install and wire** (see "Wiring" below): add `@convex-dev/mcp` with the
   app's own package manager (`npm i` / `pnpm add` / `yarn add` / `bun add` —
   match the lockfile),
   `app.use(mcp)`, `convex/mcp.ts`, `http.ts`, a `/connect` consent page,
   and a "Connected agents" section in settings.
4. **Implement tools on internal functions that take the MCP user**
   (`args: { user: vMcpUser(v.id("users")), … }`). Authorize with the
   **same access helper the UI uses**, inside the transaction, and let the
   connection's scopes narrow it (read-only scope ⇒ viewer). Never trust IDs
   from the model without that check. See
   [references/tool-design.md](references/tool-design.md) §8 and the
   package's `example/convex/access.ts`.
5. **Verify.** Add `expect(mcp.lint()).toEqual([])` to a test.
   `npx convex dev --once` + typecheck, then exercise the real
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
import { createTool, McpServer, vMcpUser } from "@convex-dev/mcp";
// Convex Auth 0.0.x: "@convex-dev/auth/server". Convex Auth v2: "@convex-dev/auth/core".
import { getAuthUserId } from "@convex-dev/auth/server";
import { v } from "convex/values";
import { components, internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";

const tool = createTool<Id<"users">>(); // user.userId typed, no casts

// Annotating the type avoids a TS inference cycle with this file's exports.
export const mcp: McpServer<Id<"users">> = new McpServer(components.mcp, {
  name: "acme", title: "Acme", version: "1.0.0",
  instructions: "Short guidance on how the tools fit together.",
  // The frontend page users approve on. Set it explicitly — don't derive it
  // from an existing SITE_URL-style var without checking what that var is.
  consentUrl: process.env.MCP_CONSENT_URL!,
  scopes: { "docs:read": "Read your documents", "docs:write": "Create and edit your documents" },
  tools: {
    search_documents: tool({
      description: "Search the user's documents by title and content. Returns up to `limit` matches, newest first.",
      args: { query: v.string(), limit: v.optional(v.number()) },
      returns: v.object({ documents: v.array(v.object({ id: v.string(), title: v.string(), snippet: v.string() })) }),
      annotations: { readOnlyHint: true },
      scope: "docs:read",
      handler: async (ctx, args, user) => ({
        // Pass the whole user: your access helper sees the connection's scopes.
        documents: await ctx.runQuery(internal.documents.searchForMcp, { user, ...args }),
      }),
    }),
  },
});

export const { getAuthRequest, authorize, listConnections, revokeConnection, createApiKey } =
  mcp.api({ getUserId: getAuthUserId });
// For the CLI and tests; internal, so only deploy credentials can call it.
export const { createApiKeyForUser } = mcp.internalApi();
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
- Two different URLs — don't mix them up:
  - `consentUrl`: the **frontend** page (`https://app.example.com/connect`).
    Set it explicitly (e.g. an `MCP_CONSENT_URL` env var). Apps often have a
    `SITE_URL` that points somewhere else on purpose (an old domain kept for
    passkeys, the Convex Auth site URL, …) — check before reusing one.
  - `siteUrl`: the public origin of the **Convex HTTP actions**, i.e. the MCP
    server URL users paste. Defaults to `CONVEX_SITE_URL`; set it when you
    serve HTTP actions from a custom domain.
- Consent page at `/connect?request=…`: if signed out, sign in and come back
  to the same URL; show `getAuthRequest` (client name, scopes, redirect
  host); Allow/Deny call `authorize({ requestId, approve })` and
  `window.location.assign(redirectUrl)`.
- Don't let the consent page be framed (clickjacking). Best: send
  `Content-Security-Policy: frame-ancestors 'none'` from your host
  (`vercel.json` headers, Netlify/Cloudflare `_headers`, Next `headers()`).
  On hosts that can't set per-route headers (Convex static hosting, static
  exports), **also** refuse to render the approval UI when framed:
  `if (window.top !== window.self) return <p>Open this page directly.</p>;`
- Add `returns` to tools that return objects: results are checked against it,
  so it also stops fields you didn't list from leaking to the agent.
- Settings: show the MCP URL, `listConnections` with "Disconnect"
  (`revokeConnection`), and "Create API key" (`createApiKey`, show once) for
  CLI agents: `claude mcp add --transport http acme <url> --header "Authorization: Bearer <key>"`.

The package's `example/` directory is a complete reference (todos app,
consent page, connections UI, `example/e2e.mjs` end-to-end script).

## Verify

```sh
# Mint a key for a test user without going through the UI or --identity:
KEY=$(npx convex run mcp:createApiKeyForUser '{"userId":"<id getUserId returns>"}' | jq -r .apiKey)
curl -s $CONVEX_SITE_URL/mcp -H "Authorization: Bearer $KEY" -H 'Content-Type: application/json' \
  -H 'MCP-Protocol-Version: 2025-06-18' -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'
```

The `userId` is whatever `getUserId` returns — for Convex Auth, a `users`
table ID (`npx convex data users --limit 1`). Prefer this over
`npx convex run … --identity`, whose identity must reproduce your auth
provider's exact `issuer`/`subject`/`tokenIdentifier`.

Call each tool once with realistic arguments, and once with a bad ID (expect
an `isError` result, not a crash).

**Cross-user check (required for every tool that takes an ID):** create a
second user with their own data and an API key, then call each tool with the
second user's key and a **valid** ID belonging to the first user. Every call
must fail or return nothing, never the other user's data. Malformed or
nonexistent IDs don't prove anything here.

Write a `convex-test` test for this too (`@convex-dev/mcp/test` +
`t.fetch("/mcp", …)`, see the package's `example/convex/mcp.test.ts`).

For a full OAuth check, connect the MCP Inspector
(`npx @modelcontextprotocol/inspector`) or Claude to the URL.

## Don'ts

- Don't take `userId`, `ownerId`, `orgId`-you-didn't-verify, or an email as a
  tool argument to decide whose data to touch.
- Don't expose `internal*` admin functions, cross-user queries, or billing
  mutations as tools without the user explicitly asking.
- Don't return whole documents with internal fields (tokens, hashes,
  `_creationTime` noise); shape results for the model.
- Don't mirror every query/mutation 1:1. See the design guide.
