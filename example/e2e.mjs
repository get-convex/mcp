// End-to-end check of the example app against a running deployment:
// discovery → DCR → authorize → consent → token → MCP → refresh → revoke.
// Usage: node example/e2e.mjs   (reads VITE_CONVEX_URL / VITE_CONVEX_SITE_URL
// from .env.local)
import { ConvexHttpClient } from "convex/browser";
import { anyApi } from "convex/server";
import { createHash, randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import assert from "node:assert/strict";

const env = Object.fromEntries(
  readFileSync(".env.local", "utf8")
    .split("\n")
    .filter((l) => /^[A-Z_]+=/.test(l))
    .map((l) => l.split(/=(.*)/s).slice(0, 2)),
);
const convexUrl = process.env.VITE_CONVEX_URL ?? env.VITE_CONVEX_URL;
const site = process.env.VITE_CONVEX_SITE_URL ?? env.VITE_CONVEX_SITE_URL;
const mcpUrl = `${site}/mcp`;
const api = anyApi;
const REDIRECT = "http://localhost:9999/callback";

const b64url = (buf) => buf.toString("base64url");
let step = 0;
const ok = (msg) => console.log(`✔ ${++step}. ${msg}`);

async function rpc(token, method, params, { id = 1, version = "2025-06-18" } = {}) {
  const res = await fetch(mcpUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      "MCP-Protocol-Version": version,
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(
      id === null
        ? { jsonrpc: "2.0", method, params }
        : { jsonrpc: "2.0", id, method, params },
    ),
  });
  const text = await res.text();
  return { status: res.status, headers: res.headers, body: text ? JSON.parse(text) : null };
}

async function token(params) {
  const res = await fetch(`${site}/mcp/oauth/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(params),
  });
  return { status: res.status, body: await res.json() };
}

/** Runs the browser part of the flow: authorize → consent page → approve. */
async function authorizeFlow(convex, clientId, scope) {
  const verifier = b64url(randomBytes(32));
  const challenge = b64url(createHash("sha256").update(verifier).digest());
  const state = b64url(randomBytes(8));
  const url = new URL(`${site}/mcp/oauth/authorize`);
  url.search = new URLSearchParams({
    response_type: "code",
    client_id: clientId,
    redirect_uri: REDIRECT,
    code_challenge: challenge,
    code_challenge_method: "S256",
    state,
    resource: mcpUrl,
    ...(scope ? { scope } : {}),
  }).toString();
  const res = await fetch(url, { redirect: "manual" });
  assert.equal(res.status, 302);
  const consent = new URL(res.headers.get("Location"));
  assert.equal(consent.pathname, "/connect");
  const requestId = consent.searchParams.get("request");

  const details = await convex.query(api.mcp.getAuthRequest, { requestId });
  assert.equal(details.clientName, "E2E Agent");
  const { redirectUrl } = await convex.action(api.mcp.authorize, {
    requestId,
    approve: true,
  });
  const back = new URL(redirectUrl);
  assert.equal(back.origin + back.pathname, REDIRECT);
  assert.equal(back.searchParams.get("state"), state);
  assert.equal(back.searchParams.get("iss"), site);
  return { code: back.searchParams.get("code"), verifier, details };
}

// 1. Unauthenticated request → 401 pointing at resource metadata.
{
  const r = await rpc(null, "initialize", {});
  assert.equal(r.status, 401);
  const challenge = r.headers.get("WWW-Authenticate");
  assert.match(challenge, /resource_metadata="[^"]+\/\.well-known\/oauth-protected-resource\/mcp"/);
  ok("401 with WWW-Authenticate resource_metadata");
}

// 2. Discovery documents.
const prm = await (await fetch(`${site}/.well-known/oauth-protected-resource/mcp`)).json();
assert.equal(prm.resource, mcpUrl);
const asMeta = await (
  await fetch(`${prm.authorization_servers[0]}/.well-known/oauth-authorization-server`)
).json();
assert.equal(asMeta.issuer, prm.authorization_servers[0]);
assert.deepEqual(asMeta.code_challenge_methods_supported, ["S256"]);
ok("protected resource + authorization server metadata");

// 3. Dynamic client registration.
const reg = await fetch(asMeta.registration_endpoint, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ client_name: "E2E Agent", redirect_uris: [REDIRECT] }),
});
assert.equal(reg.status, 201);
const { client_id: clientId } = await reg.json();
const badReg = await fetch(asMeta.registration_endpoint, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ redirect_uris: ["javascript:alert(1)"] }),
});
assert.equal(badReg.status, 400);
ok("DCR registers a public client and rejects bad redirect URIs");

// 4. Unknown client / unregistered redirect → error page, never a redirect.
{
  const u = new URL(asMeta.authorization_endpoint);
  u.search = new URLSearchParams({
    response_type: "code",
    client_id: clientId,
    redirect_uri: "https://evil.example/cb",
    code_challenge: "x".repeat(43),
    code_challenge_method: "S256",
  }).toString();
  const res = await fetch(u, { redirect: "manual" });
  assert.equal(res.status, 400);
  ok("unregistered redirect_uri is refused without redirecting");
}

// 5. Sign in to the app (anonymously) and approve on the consent page.
const convex = new ConvexHttpClient(convexUrl);
const signIn = await convex.action(api.auth.signIn, { provider: "anonymous" });
convex.setAuth(signIn.tokens.token);
const listId = await convex.mutation(api.lists.ensureDefault, {});
const { code, verifier, details } = await authorizeFlow(convex, clientId);
assert.deepEqual(
  details.scopes.map((s) => s.name),
  ["todos:read", "todos:write"],
);
ok("consent page approves and redirects back with code, state and iss");

// 6. Code exchange: wrong verifier fails and burns the code.
{
  const { code: code2 } = await authorizeFlow(convex, clientId);
  const bad = await token({
    grant_type: "authorization_code",
    code: code2,
    redirect_uri: REDIRECT,
    client_id: clientId,
    code_verifier: b64url(randomBytes(32)),
  });
  assert.equal(bad.status, 400);
  assert.equal(bad.body.error, "invalid_grant");
  ok("PKCE mismatch rejected");
}
const exchanged = await token({
  grant_type: "authorization_code",
  code,
  redirect_uri: REDIRECT,
  client_id: clientId,
  code_verifier: verifier,
  resource: mcpUrl,
});
assert.equal(exchanged.status, 200, JSON.stringify(exchanged.body));
let { access_token: accessToken, refresh_token: refreshToken } = exchanged.body;
assert.equal(exchanged.body.scope, "todos:read todos:write");
const replay = await token({
  grant_type: "authorization_code",
  code,
  redirect_uri: REDIRECT,
  client_id: clientId,
  code_verifier: verifier,
});
assert.equal(replay.body.error, "invalid_grant");
ok("code exchanged once for tokens; replay rejected");

// 7. MCP protocol.
{
  const init = await rpc(accessToken, "initialize", {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "e2e", version: "0" },
  });
  assert.equal(init.status, 200);
  assert.equal(init.body.result.protocolVersion, "2025-06-18");
  assert.equal(init.body.result.serverInfo.name, "todos");
  const note = await rpc(accessToken, "notifications/initialized", undefined, { id: null });
  assert.equal(note.status, 202);
  const badVersion = await rpc(accessToken, "ping", {}, { version: "1999-01-01" });
  assert.equal(badVersion.status, 400);
  ok("initialize, 202 for notifications, 400 for unsupported protocol version");

  const list = await rpc(accessToken, "tools/list", {});
  const names = list.body.result.tools.map((t) => t.name).sort();
  assert.deepEqual(names, ["add_todo", "delete_todo", "list_lists", "list_todos", "set_todo_done"]);
  const addTool = list.body.result.tools.find((t) => t.name === "add_todo");
  assert.deepEqual(addTool.inputSchema, {
    type: "object",
    properties: { listId: { type: "string" }, text: { type: "string" } },
    required: ["listId", "text"],
    additionalProperties: false,
  });
  ok("tools/list returns JSON Schemas generated from Convex validators");

  const added = await rpc(accessToken, "tools/call", {
    name: "add_todo",
    arguments: { listId, text: "Buy milk" },
  });
  assert.equal(added.body.result.structuredContent.text, "Buy milk");
  const listed = await rpc(accessToken, "tools/call", { name: "list_todos", arguments: { listId } });
  assert.equal(listed.body.result.structuredContent.todos.length, 1);
  // The app's own UI sees the same data.
  const viaApp = await convex.query(api.todos.list, { listId });
  assert.equal(viaApp.length, 1);
  const done = await rpc(accessToken, "tools/call", {
    name: "set_todo_done",
    arguments: { id: added.body.result.structuredContent.id, done: true },
  });
  assert.equal(done.body.result.structuredContent.done, true);
  ok("tools/call reads and writes the signed-in user's data");

  const invalid = await rpc(accessToken, "tools/call", {
    name: "add_todo",
    arguments: { listId, text: 42 },
  });
  assert.equal(invalid.body.result.isError, true);
  assert.match(invalid.body.result.content[0].text, /arguments\.text: expected string/);
  const appError = await rpc(accessToken, "tools/call", {
    name: "delete_todo",
    arguments: { id: "nope" },
  });
  assert.equal(appError.body.result.isError, true);
  assert.match(appError.body.result.content[0].text, /No todo with id nope/);
  const unknown = await rpc(accessToken, "tools/call", { name: "nope", arguments: {} });
  assert.equal(unknown.body.error.code, -32602);
  ok("argument validation and ConvexErrors become isError tool results");
}

// 7b. MCP 2026-07-28: stateless requests with _meta and mirrored headers.
{
  const META = "io.modelcontextprotocol/";
  const modern = async (method, params = {}) => {
    const res = await fetch(mcpUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
        Authorization: `Bearer ${accessToken}`,
        "MCP-Protocol-Version": "2026-07-28",
        "Mcp-Method": method,
        ...(params.name ? { "Mcp-Name": params.name } : {}),
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method,
        params: {
          ...params,
          _meta: {
            [`${META}protocolVersion`]: "2026-07-28",
            [`${META}clientCapabilities`]: {},
            [`${META}clientInfo`]: { name: "e2e", version: "0" },
          },
        },
      }),
    });
    return { status: res.status, body: await res.json() };
  };
  const discover = await modern("server/discover");
  assert.equal(discover.body.result.resultType, "complete");
  assert.ok(discover.body.result.supportedVersions.includes("2026-07-28"));
  const list = await modern("tools/list");
  assert.equal(list.body.result.tools.length, 5);
  assert.equal(list.body.result.cacheScope, "private");
  const called = await modern("tools/call", { name: "list_todos", arguments: { listId } });
  assert.equal(called.body.result.resultType, "complete");
  assert.ok(Array.isArray(called.body.result.structuredContent.todos));
  ok("2026-07-28: server/discover, tools/list, tools/call without initialize");
}

// 8. Refresh rotation and reuse detection.
{
  const refreshed = await token({
    grant_type: "refresh_token",
    refresh_token: refreshToken,
    client_id: clientId,
  });
  assert.equal(refreshed.status, 200);
  const oldRefresh = refreshToken;
  accessToken = refreshed.body.access_token;
  refreshToken = refreshed.body.refresh_token;
  assert.equal((await rpc(accessToken, "ping", {})).status, 200);
  // Replaying the rotated token revokes the whole connection.
  const reuse = await token({
    grant_type: "refresh_token",
    refresh_token: oldRefresh,
    client_id: clientId,
  });
  assert.equal(reuse.body.error, "invalid_grant");
  assert.equal((await rpc(accessToken, "ping", {})).status, 401);
  const after = await token({
    grant_type: "refresh_token",
    refresh_token: refreshToken,
    client_id: clientId,
  });
  assert.equal(after.body.error, "invalid_grant");
  ok("refresh rotates; replaying an old refresh token revokes the connection");
}

// 9. Scopes: a read-only connection can't see or call write tools.
{
  const { code: roCode, verifier: roVerifier } = await authorizeFlow(
    convex,
    clientId,
    "todos:read",
  );
  const ro = await token({
    grant_type: "authorization_code",
    code: roCode,
    redirect_uri: REDIRECT,
    client_id: clientId,
    code_verifier: roVerifier,
  });
  const roToken = ro.body.access_token;
  const tools = (await rpc(roToken, "tools/list", {})).body.result.tools;
  assert.deepEqual(tools.map((t) => t.name), ["list_lists", "list_todos"]);
  const denied = await rpc(roToken, "tools/call", {
    name: "add_todo",
    arguments: { text: "x" },
  });
  assert.equal(denied.status, 403);
  assert.match(denied.headers.get("WWW-Authenticate"), /insufficient_scope/);
  ok("scoped tokens only see and call tools in scope (403 otherwise)");
}

// 10. Connections page + API keys.
{
  const { apiKey } = await convex.action(api.mcp.createApiKey, { name: "CLI" });
  const viaKey = await rpc(apiKey, "tools/call", { name: "list_todos", arguments: { listId } });
  assert.equal(viaKey.body.result.structuredContent.todos.length, 1);
  const connections = await convex.query(api.mcp.listConnections, {});
  assert.deepEqual(connections.map((c) => c.kind).sort(), ["apiKey", "oauth"]);
  for (const c of connections) {
    assert.equal(await convex.mutation(api.mcp.revokeConnection, { id: c.id }), true);
  }
  assert.equal((await rpc(apiKey, "ping", {})).status, 401);
  ok("API keys work and revoking a connection cuts off access");
}

// 11. Another user can't use someone else's connection approval.
{
  const other = new ConvexHttpClient(convexUrl);
  const otherSignIn = await other.action(api.auth.signIn, { provider: "anonymous" });
  other.setAuth(otherSignIn.tokens.token);
  const { code: c, verifier: ver } = await authorizeFlow(other, clientId);
  const t = await token({
    grant_type: "authorization_code",
    code: c,
    redirect_uri: REDIRECT,
    client_id: clientId,
    code_verifier: ver,
  });
  const otherToken = t.body.access_token;
  const theirs = await rpc(otherToken, "tools/call", { name: "list_todos", arguments: { listId } });
  assert.equal(theirs.body.result.isError, true);
  const lists = await rpc(otherToken, "tools/call", { name: "list_lists", arguments: {} });
  assert.equal(lists.body.result.structuredContent.lists.length, 0);
  ok("each user's agent only sees that user's data");

  // 12. Sharing: once A shares as viewer, B's agent can read but not write.
  const [mine] = await convex.query(api.lists.mine, {});
  await other.mutation(api.lists.join, { code: mine.viewerCode });
  const shared = await rpc(otherToken, "tools/call", { name: "list_todos", arguments: { listId } });
  assert.equal(shared.body.result.structuredContent.todos.length, 1);
  const write = await rpc(otherToken, "tools/call", {
    name: "add_todo",
    arguments: { listId, text: "nope" },
  });
  assert.equal(write.body.result.isError, true);
  ok("shared as viewer: the other user's agent can read, not write");
}

// 13. GET /mcp explains itself to agents; SSE GETs still get 405.
{
  const page = await fetch(mcpUrl, { headers: { Accept: "text/html" } });
  assert.equal(page.status, 200);
  const text = await page.text();
  assert.match(text, /oauth\/device/);
  assert.match(text, /client_id=mcp-agent/);
  const sse = await fetch(mcpUrl, { headers: { Accept: "text/event-stream" } });
  assert.equal(sse.status, 405);
  ok("GET /mcp returns an agent-readable guide; SSE GET is 405");
}

// 14. Device flow: an agent with only HTTP gets a link for the user to approve.
{
  const form = (o) => ({
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(o),
  });
  const asMeta2 = await (await fetch(`${site}/.well-known/oauth-authorization-server`)).json();
  assert.equal(asMeta2.device_authorization_endpoint, `${site}/mcp/oauth/device`);
  assert.ok(asMeta2.grant_types_supported.includes("urn:ietf:params:oauth:grant-type:device_code"));

  const start = await fetch(
    asMeta2.device_authorization_endpoint,
    form({ client_id: "mcp-agent", client_name: "Chat <script>Agent", scope: "todos:read" }),
  );
  assert.equal(start.status, 200);
  const dev = await start.json();
  assert.match(dev.user_code, /^[A-Z]{4}-[A-Z]{4}$/);
  const link = new URL(dev.verification_uri_complete);
  assert.equal(link.pathname, "/connect");

  const poll = () =>
    fetch(
      `${site}/mcp/oauth/token`,
      form({
        grant_type: "urn:ietf:params:oauth:grant-type:device_code",
        client_id: "mcp-agent",
        device_code: dev.device_code,
      }),
    ).then(async (r) => ({ status: r.status, body: await r.json() }));
  assert.equal((await poll()).body.error, "authorization_pending");
  assert.equal((await poll()).body.error, "slow_down");

  // The user opens the link (or types the code) and approves.
  const requestId = link.searchParams.get("request");
  assert.equal(
    await convex.mutation(api.mcp.findAuthRequest, { userCode: dev.user_code.toLowerCase().replace("-", " ") }),
    requestId,
  );
  const details = await convex.query(api.mcp.getAuthRequest, { requestId });
  assert.equal(details.kind, "device");
  assert.equal(details.userCode, dev.user_code);
  assert.equal(details.clientName, "Chat scriptAgent");
  await assert.rejects(
    convex.action(api.mcp.authorize, { requestId, approve: true }),
    /Confirm the code/,
  );
  const { redirectUrl } = await convex.action(api.mcp.authorize, {
    requestId,
    approve: true,
    userCode: dev.user_code,
  });
  assert.equal(redirectUrl, null);

  const got = await poll();
  assert.equal(got.status, 200, JSON.stringify(got.body));
  assert.equal(got.body.refresh_token, undefined);
  assert.equal(got.body.scope, "todos:read");
  const listed = await rpc(got.body.access_token, "tools/call", {
    name: "list_todos",
    arguments: { listId },
  });
  assert.equal(listed.body.result.structuredContent.todos.length, 1);
  const write = await rpc(got.body.access_token, "tools/call", {
    name: "add_todo",
    arguments: { listId, text: "x" },
  });
  assert.equal(write.status, 403);
  assert.equal((await poll()).body.error, "invalid_grant"); // single use
  ok("device flow: link + code → user approves → scoped access token, no refresh token");

  // Denied and unknown-client cases.
  const second = await (
    await fetch(asMeta2.device_authorization_endpoint, form({ client_id: "mcp-agent" }))
  ).json();
  const rid = new URL(second.verification_uri_complete).searchParams.get("request");
  await convex.action(api.mcp.authorize, { requestId: rid, approve: false });
  const denied = await fetch(
    `${site}/mcp/oauth/token`,
    form({
      grant_type: "urn:ietf:params:oauth:grant-type:device_code",
      client_id: "mcp-agent",
      device_code: second.device_code,
    }),
  ).then((r) => r.json());
  assert.equal(denied.error, "access_denied");
  const unknown = await fetch(asMeta2.device_authorization_endpoint, form({ client_id: "nope" }));
  assert.equal(unknown.status, 401);
  ok("device flow: denial → access_denied; unknown client → 401");
}

console.log("\nAll end-to-end checks passed.");
