import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { api, internal } from "./_generated/api.js";
import { initConvexTest } from "./setup.test.js";
import { mcp } from "./mcp.js";

beforeAll(() => {
  process.env.CONVEX_SITE_URL = "https://example.convex.site";
});
afterAll(() => {
  delete process.env.CONVEX_SITE_URL;
});

type T = ReturnType<typeof initConvexTest>;

async function newUser(t: T, scopes?: string[]) {
  const userId = await t.run((ctx) => ctx.db.insert("users", {}));
  const asUser = t.withIdentity({ subject: `${userId}|session` });
  const listId = await asUser.mutation(api.lists.ensureDefault, {});
  const { apiKey } = await asUser.action(api.mcp.createApiKey, { name: "test", scopes });
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const res = await t.fetch("/mcp", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
        "MCP-Protocol-Version": "2025-06-18",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name, arguments: args },
      }),
    });
    return { status: res.status, body: await res.json() };
  };
  return { userId, asUser, listId, apiKey, call };
}

describe("MCP server in an app", () => {
  test("has no risky tool setups", () => {
    expect(mcp.lint()).toEqual([]);
  });

  test("rejects requests without credentials", async () => {
    const t = initConvexTest();
    const res = await t.fetch("/mcp", {
      method: "POST",
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" }),
    });
    expect(res.status).toBe(401);
    expect(res.headers.get("WWW-Authenticate")).toContain(
      'resource_metadata="https://example.convex.site/.well-known/oauth-protected-resource/mcp"',
    );
  });

  test("tools and the UI see the same data", async () => {
    const t = initConvexTest();
    const a = await newUser(t);
    const added = await a.call("add_todo", { listId: a.listId, text: "Write tests" });
    expect(added.body.result.structuredContent).toMatchObject({ text: "Write tests", done: false });
    expect(await a.asUser.query(api.todos.list, { listId: a.listId })).toHaveLength(1);
    const lists = await a.call("list_lists");
    expect(lists.body.result.structuredContent.lists).toEqual([
      { id: a.listId, name: "My todos", role: "owner" },
    ]);
  });

  test("another user's list is invisible, by UI and by agent", async () => {
    const t = initConvexTest();
    const a = await newUser(t);
    const b = await newUser(t);
    const viaAgent = await b.call("add_todo", { listId: a.listId, text: "x" });
    expect(viaAgent.body.result.isError).toBe(true);
    expect(viaAgent.body.result.content[0].text).toBe(`No list with id ${a.listId}`);
    await expect(b.asUser.mutation(api.todos.add, { listId: a.listId, text: "x" })).rejects.toThrow(
      /No list with id/,
    );
  });

  test("sharing: a viewer can read but not edit — in the UI and through an agent", async () => {
    const t = initConvexTest();
    const a = await newUser(t);
    const b = await newUser(t);
    await a.call("add_todo", { listId: a.listId, text: "Shared" });
    const [mine] = await a.asUser.query(api.lists.mine, {});
    await b.asUser.mutation(api.lists.join, { code: mine.viewerCode! });

    const read = await b.call("list_todos", { listId: a.listId });
    expect(read.body.result.structuredContent.todos).toHaveLength(1);
    const write = await b.call("add_todo", { listId: a.listId, text: "nope" });
    expect(write.body.result.isError).toBe(true);
    await expect(b.asUser.mutation(api.todos.add, { listId: a.listId, text: "nope" })).rejects.toThrow();

    // Upgrading to editor lets both paths write.
    await b.asUser.mutation(api.lists.join, { code: mine.editorCode! });
    const ok = await b.call("add_todo", { listId: a.listId, text: "from B's agent" });
    expect(ok.body.result.structuredContent.text).toBe("from B's agent");
  });

  test("a read-only connection acts as a viewer even on the user's own list", async () => {
    const t = initConvexTest();
    const a = await newUser(t, ["todos:read"]);
    const list = await a.call("list_todos", { listId: a.listId });
    expect(list.status).toBe(200);
    // The tool itself is out of scope (403); the access helper would also refuse.
    const write = await a.call("add_todo", { listId: a.listId, text: "x" });
    expect(write.status).toBe(403);
  });

  test("connections can be listed and revoked", async () => {
    const t = initConvexTest();
    const a = await newUser(t);
    const [connection] = await a.asUser.query(api.mcp.listConnections, {});
    expect(connection).toMatchObject({ kind: "apiKey", name: "test" });
    await a.asUser.mutation(api.mcp.revokeConnection, { id: connection.id });
    expect((await a.call("list_lists")).status).toBe(401);
  });

  test("operators can mint a key for a user from the CLI", async () => {
    const t = initConvexTest();
    const userId = await t.run((ctx) => ctx.db.insert("users", {}));
    const { apiKey } = await t.action(internal.mcp.createApiKeyForUser, { userId });
    const res = await t.fetch("/mcp", {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "MCP-Protocol-Version": "2025-06-18" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name: "list_lists", arguments: {} },
      }),
    });
    expect((await res.json()).result.structuredContent).toEqual({ lists: [] });
  });

  test("serves discovery metadata", async () => {
    const t = initConvexTest();
    const res = await t.fetch("/.well-known/oauth-authorization-server");
    expect(await res.json()).toMatchObject({
      issuer: "https://example.convex.site",
      token_endpoint: "https://example.convex.site/mcp/oauth/token",
      code_challenge_methods_supported: ["S256"],
      scopes_supported: ["todos:read", "todos:write"],
    });
  });
});
