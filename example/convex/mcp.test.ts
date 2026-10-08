import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { api } from "./_generated/api.js";
import { initConvexTest } from "./setup.test.js";

beforeAll(() => {
  process.env.CONVEX_SITE_URL = "https://example.convex.site";
});
afterAll(() => {
  delete process.env.CONVEX_SITE_URL;
});

async function signedIn() {
  const t = initConvexTest();
  const userId = await t.run((ctx) => ctx.db.insert("users", {}));
  const asUser = t.withIdentity({ subject: `${userId}|session` });
  const { apiKey } = await asUser.action(api.mcp.createApiKey, { name: "test" });
  const call = async (method: string, params?: unknown) => {
    const res = await t.fetch("/mcp", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
        "MCP-Protocol-Version": "2025-06-18",
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    });
    return { status: res.status, body: await res.json() };
  };
  return { t, asUser, call };
}

describe("MCP server in an app", () => {
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

  test("tools act on the API key owner's data", async () => {
    const { asUser, call } = await signedIn();
    const added = await call("tools/call", {
      name: "add_todo",
      arguments: { text: "Write tests" },
    });
    expect(added.body.result.structuredContent).toMatchObject({
      text: "Write tests",
      done: false,
    });
    expect(await asUser.query(api.todos.list, {})).toHaveLength(1);
    const list = await call("tools/call", { name: "list_todos", arguments: {} });
    expect(list.body.result.structuredContent.todos).toHaveLength(1);
  });

  test("connections can be listed and revoked", async () => {
    const { asUser, call } = await signedIn();
    const [connection] = await asUser.query(api.mcp.listConnections, {});
    expect(connection).toMatchObject({ kind: "apiKey", name: "test" });
    await asUser.mutation(api.mcp.revokeConnection, { id: connection.id });
    expect((await call("ping")).status).toBe(401);
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
