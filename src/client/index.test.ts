import { describe, expect, test, vi } from "vitest";
import { ConvexError, v } from "convex/values";
import { McpServer, tool } from "./index.js";
import { components } from "./setup.test.js";

function server(tools: ConstructorParameters<typeof McpServer>[1]["tools"]) {
  return new McpServer(components.mcp, {
    name: "test",
    version: "1",
    consentUrl: "https://app.example/connect",
    siteUrl: "https://site.example",
    scopes: { read: "Read", write: "Write" },
    tools,
  });
}

// A ctx whose token lookup returns a valid connection with `scopes`.
function ctx(scopes = ["read", "write"]) {
  return {
    runQuery: vi.fn(async () => ({
      userId: "user1",
      grantId: "g1",
      kind: "apiKey",
      scopes,
      resource: "https://site.example/mcp",
      stale: false,
    })),
    runMutation: vi.fn(),
    runAction: vi.fn(),
  } as any;
}

async function call(s: McpServer, c: any, body: unknown, version = "2025-06-18") {
  const res = await s.handleMcp(
    c,
    new Request("https://site.example/mcp", {
      method: "POST",
      headers: {
        Authorization: "Bearer key",
        "MCP-Protocol-Version": version,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    }),
  );
  const text = await res.text();
  return { status: res.status, headers: res.headers, body: text ? JSON.parse(text) : null };
}

// `id: null` builds a notification (no id).
const rpc = (method: string, params?: unknown, id: number | null = 1) => ({
  jsonrpc: "2.0",
  ...(id === null ? {} : { id }),
  method,
  params,
});

describe("McpServer", () => {
  test("enforces `returns` so extra fields never leak", async () => {
    const s = server({
      whoami: tool({
        description: "Who am I",
        returns: v.object({ name: v.string() }),
        handler: async () => ({ name: "Ada", passwordHash: "secret" }) as any,
      }),
    });
    const r = await call(s, ctx(), rpc("tools/call", { name: "whoami", arguments: {} }));
    expect(r.body.result.isError).toBe(true);
    expect(JSON.stringify(r.body)).not.toContain("secret");
  });

  test("passes the verified user to handlers, never arguments", async () => {
    const handler = vi.fn(async (_ctx: unknown, args: { n: bigint }, user: { userId: string }) => ({
      n: args.n * 2n,
      user: user.userId,
    }));
    const s = server({
      double: tool({
        description: "Double",
        args: { n: v.int64() },
        returns: v.object({ n: v.int64(), user: v.string() }),
        handler,
      }),
    });
    const r = await call(s, ctx(), rpc("tools/call", { name: "double", arguments: { n: "21" } }));
    expect(r.body.result.structuredContent).toEqual({ n: "42", user: "user1" });
  });

  test("ConvexError messages reach the model; other errors don't", async () => {
    const s = server({
      a: tool({ description: "a", handler: async () => { throw new ConvexError("Nope: try list_x"); } }),
      b: tool({ description: "b", handler: async () => { throw new Error("db password is hunter2"); } }),
    });
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const a = await call(s, ctx(), rpc("tools/call", { name: "a", arguments: {} }));
    const b = await call(s, ctx(), rpc("tools/call", { name: "b", arguments: {} }));
    spy.mockRestore();
    expect(a.body.result.content[0].text).toBe("Nope: try list_x");
    expect(b.body.result.isError).toBe(true);
    expect(b.body.result.content[0].text).not.toContain("hunter2");
  });

  test("scopes filter tools/list and gate tools/call with 403", async () => {
    const s = server({
      r: tool({ description: "r", scope: "read", handler: async () => "ok" }),
      w: tool({ description: "w", scope: "write", handler: async () => "ok" }),
    });
    const list = await call(s, ctx(["read"]), rpc("tools/list"));
    expect(list.body.result.tools.map((t: any) => t.name)).toEqual(["r"]);
    const denied = await call(s, ctx(["read"]), rpc("tools/call", { name: "w", arguments: {} }));
    expect(denied.status).toBe(403);
    expect(denied.headers.get("WWW-Authenticate")).toContain('scope="write"');
  });

  test("protocol: notifications get 202, batches only for 2025-03-26", async () => {
    const s = server({});
    expect((await call(s, ctx(), rpc("notifications/initialized", undefined, null))).status).toBe(202);
    expect((await call(s, ctx(), [rpc("ping")])).status).toBe(400);
    const batch = await call(s, ctx(), [rpc("ping", {}, 1), rpc("ping", {}, 2)], "2025-03-26");
    expect(batch.body.map((m: any) => m.id)).toEqual([1, 2]);
    const unknown = await call(s, ctx(), rpc("resources/list"));
    expect(unknown.body.error.code).toBe(-32601);
  });

  test("tokens for another resource are rejected", async () => {
    const s = server({});
    const c = ctx();
    c.runQuery.mockResolvedValueOnce({
      userId: "u",
      grantId: "g",
      kind: "access",
      scopes: [],
      resource: "https://other.example/mcp",
      stale: false,
    });
    expect((await call(s, c, rpc("ping"))).status).toBe(401);
  });

  test("browser origins must be allowed", async () => {
    const s = server({});
    const res = await s.handleMcp(
      ctx(),
      new Request("https://site.example/mcp", {
        method: "POST",
        headers: { Origin: "https://evil.example", Authorization: "Bearer key" },
        body: JSON.stringify(rpc("ping")),
      }),
    );
    expect(res.status).toBe(403);
  });

  test("rejects tools with undeclared scopes", () => {
    expect(() =>
      server({ x: tool({ description: "x", scope: "admin", handler: async () => null }) }),
    ).toThrow(/scope "admin"/);
  });
});
