---
name: convex-mcp-security
description: Security audit of a Convex app's MCP server built with @convex-dev/mcp — who a tool call acts as, cross-user access through tool IDs, functions taking userId that are reachable from clients, data leaking through results, prompt-injection + exfiltration paths, downstream credentials, consent-page and configuration mistakes. Findings are proven (live with two real users, or statically for config/code defects), then fixed and re-proven. TRIGGER before shipping or publishing an app's MCP server, after adding or changing MCP tools, or on "is my MCP server safe", "audit my MCP tools", "security review of the agent integration". SKIP when the app has no @convex-dev/mcp server (use a general Convex authz audit instead).
---

# Audit an app's MCP server

An MCP server lets an agent act **as the user** with whatever tools you gave
it. What makes this different from auditing the app's UI:

1. **Arguments come from a model, not your UI.** Anything the UI never sends
   (another user's ID, a huge limit, an unexpected enum) will be sent.
2. **The agent can be steered by what it reads.** Text returned by your tools
   — especially text other people wrote — can carry instructions. A server
   that returns untrusted content *and* can send data somewhere is an
   exfiltration path even when every call is individually authorized.
   Annotations and neat result fields do **not** prevent this; only
   server-side policy does.
3. **Tool handlers have no `ctx.auth`.** Identity is only `user.userId`,
   passed by the component. Any identity derived another way is a bug.

The component handles OAuth, token storage, audience binding, scopes,
argument validation and `returns` validation (for plain return values and
`structuredContent`; not for `content` blocks you build with
`callToolResult`). This audit is about **the app's side**: its tools, the
functions they call, downstream credentials, its consent page and its
configuration. Report suspected component bugs upstream, with a repro.

## Workflow

1. **Inventory.** Read `convex/mcp.ts` (wherever `new McpServer` is),
   `http.ts`, `convex.config.ts`, the consent page, its hosting config, and
   every function the tools call. Fill the table in
   [references/checklist.md](references/checklist.md) §Inventory (for fewer
   than ~6 tools a bullet per tool is fine).
2. **Check** each checklist item; note candidates with file:line.
3. **Prove** each candidate (§Proving it) and label the proof **live** or
   **static**. Live proof is required for anything that depends on runtime
   behavior (cross-user access, reachability of a function, injection
   flow). Configuration, header, schema and code-structure defects may be
   proven statically by quoting the code/config. Unproven = "hypothesis".
4. **Fix**, re-run the same proof, run tests + typecheck. If asked to audit
   only, write the proposed fix and "not run" under Re-proof.
5. **Report** (§Report).

## Proving it

Use a dev or local deployment you're authorized to modify, never production
or real users' data. Create **two users, A and B**, each with their own data,
and MCP credentials for each: a full key and a read-only key (to prove a
read-only connection is possible).

```js
// node prove.mjs — adjust sign-in to the app's auth (this is Convex Auth Anonymous)
import { ConvexHttpClient } from "convex/browser";
import { anyApi as api } from "convex/server";
const CONVEX = process.env.CONVEX_URL, SITE = process.env.SITE_URL;
async function user() {
  const c = new ConvexHttpClient(CONVEX);
  const { tokens } = await c.action(api.auth.signIn, { provider: "anonymous" });
  c.setAuth(tokens.token);
  const full = (await c.action(api.mcp.createApiKey, { name: "full" })).apiKey;
  const ro = (await c.action(api.mcp.createApiKey, { name: "ro", scopes: ["<read scope>"] })).apiKey;
  return { c, full, ro };
}
const META = "io.modelcontextprotocol/";
async function mcp(key, method, params = {}) {
  const res = await fetch(`${SITE}/mcp`, { method: "POST", headers: {
    Authorization: `Bearer ${key}`, "Content-Type": "application/json",
    "MCP-Protocol-Version": "2026-07-28", "Mcp-Method": method,
    ...(params.name ? { "Mcp-Name": params.name } : {}) },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params: { ...params,
      _meta: { [`${META}protocolVersion`]: "2026-07-28", [`${META}clientCapabilities`]: {} } } }) });
  return { status: res.status, body: await res.json(), bytes: Number(res.headers.get("content-length")) };
}
```

- **Cross-user:** for every tool taking an ID, call it with B's key and a
  **valid ID owned by A**, then confirm A's data is unchanged. Malformed or
  nonexistent IDs prove nothing.
- **Reachability of functions that take `userId`:** call them as a browser
  would — with no auth and as B — using the raw HTTP API, which shows the
  real error:
  `curl -s $CONVEX_URL/api/mutation -H 'Content-Type: application/json' -d '{"path":"todos:addForUser","args":{"userId":"<A>","text":"x"},"format":"json"}'`.
  "Could not find public function" means internal (good). `npx convex run`
  is **not** a proof of exposure: it uses deploy credentials and can call
  internal functions; use it with `--identity` only to test auth behavior.
- **Result size:** insert large content, list it, report the response bytes.
- **Injection flow:** have B write an instruction into content A's tools
  return (a comment, a shared doc), call A's read tool, and show it reaches
  the agent next to an outbound tool with no server-side policy stopping
  the follow-up call.
- **OAuth path** (only if needed): the package's `example/e2e.mjs` drives
  DCR → authorize → consent → token and is a ready template.
- Turn each proven finding into a `convex-test` regression test
  (`@convex-dev/mcp/test`, `t.fetch("/mcp", …)`).

## Report

```
## MCP security audit — <app>
| # | Severity | Finding | Proof (live/static) | Fix | Re-proof |
| 1 | Critical | addForUser is a public mutation that trusts its userId arg: anyone can add todos to any account | live: curl /api/mutation, no auth → inserted for A | internalMutation | same call → "Could not find public function" |
```

Severity:
- **Critical** — proven cross-user *write*, or read of sensitive data
  (messages, documents, PII, credentials); acting as another user; account
  takeover; payments or credential theft.
- **High** — proven cross-user read of low-sensitivity data; a proven
  injection → exfiltration flow; secrets in results; a destructive or
  outbound tool reachable by a read-only connection; downstream token
  passthrough.
- **Medium** — unbounded results/inputs, missing `returns` on tools that
  return sensitive objects, consent page frameable or not showing the
  redirect, overly broad config, an untrusted-content + outbound tool
  combination without server-side policy (threat, not yet proven).
- **Low** — annotations/descriptions that mislead a client's safety UI,
  missing `returns` on harmless tools.

Then: checked-and-fine (one line each), **not verified** (never omit
silently, e.g. production headers), and an **Other** line for correctness
bugs that aren't security issues.

## Rules

- Don't weaken a check to make a test pass; don't remove a tool the user
  wants without asking.
- Don't run proofs against production or real users' data.
- Don't report component internals as app findings without a reproduction.
