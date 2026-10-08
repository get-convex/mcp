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

describe("MCP 2026-07-28 (stateless)", () => {
  const META = "io.modelcontextprotocol/";
  const meta = {
    [`${META}protocolVersion`]: "2026-07-28",
    [`${META}clientCapabilities`]: {},
    [`${META}clientInfo`]: { name: "test", version: "1" },
  };
  async function modern(
    s: McpServer,
    method: string,
    params: Record<string, unknown> = {},
    headers: Record<string, string> = {},
  ) {
    const res = await s.handleMcp(
      ctx(),
      new Request("https://site.example/mcp", {
        method: "POST",
        headers: {
          Authorization: "Bearer key",
          "Content-Type": "application/json",
          "MCP-Protocol-Version": "2026-07-28",
          "Mcp-Method": method,
          ...(typeof params.name === "string" ? { "Mcp-Name": params.name } : {}),
          ...headers,
        },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params: { ...params, _meta: meta } }),
      }),
    );
    const text = await res.text();
    return { status: res.status, body: text ? JSON.parse(text) : null };
  }
  const s = () =>
    server({
      echo: tool({
        description: "Echo",
        args: { text: v.string() },
        returns: v.object({ text: v.string() }),
        handler: async (_ctx, args) => ({ text: args.text }),
      }),
    });

  test("server/discover advertises versions, capabilities and identity", async () => {
    const r = await modern(s(), "server/discover");
    expect(r.status).toBe(200);
    expect(r.body.result).toMatchObject({
      resultType: "complete",
      supportedVersions: expect.arrayContaining(["2026-07-28", "2025-11-25"]),
      capabilities: { tools: {} },
      cacheScope: "public",
      _meta: { [`${META}serverInfo`]: { name: "test", version: "1" } },
    });
  });

  test("tools/list and tools/call carry resultType and cache hints", async () => {
    const list = await modern(s(), "tools/list");
    expect(list.body.result).toMatchObject({ resultType: "complete", cacheScope: "private" });
    expect(list.body.result.ttlMs).toBeGreaterThan(0);
    const call = await modern(s(), "tools/call", { name: "echo", arguments: { text: "hi" } });
    expect(call.body.result).toMatchObject({
      resultType: "complete",
      structuredContent: { text: "hi" },
    });
  });

  test("headers must match the body (-32020)", async () => {
    const wrongName = await modern(
      s(),
      "tools/call",
      { name: "echo", arguments: { text: "x" } },
      { "Mcp-Name": "other" },
    );
    expect(wrongName.status).toBe(400);
    expect(wrongName.body.error.code).toBe(-32020);
    const wrongMethod = await modern(s(), "tools/list", {}, { "Mcp-Method": "tools/call" });
    expect(wrongMethod.body.error.code).toBe(-32020);
    // Base64 sentinel values are decoded before comparing.
    const encoded = await modern(
      s(),
      "tools/call",
      { name: "echo", arguments: { text: "x" } },
      { "Mcp-Name": `=?base64?${btoa("echo")}?=` },
    );
    expect(encoded.status).toBe(200);
  });

  test("unsupported versions list what is supported (-32022)", async () => {
    const res = await s().handleMcp(
      ctx(),
      new Request("https://site.example/mcp", {
        method: "POST",
        headers: { Authorization: "Bearer key", "MCP-Protocol-Version": "2099-01-01", "Mcp-Method": "tools/list" },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "tools/list",
          params: { _meta: { ...meta, [`${META}protocolVersion`]: "2099-01-01" } },
        }),
      }),
    );
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error.code).toBe(-32022);
    expect(body.error.data).toMatchObject({ requested: "2099-01-01", supported: expect.arrayContaining(["2026-07-28"]) });
  });

  test("missing required _meta is -32602 / 400; unknown methods 404", async () => {
    const res = await s().handleMcp(
      ctx(),
      new Request("https://site.example/mcp", {
        method: "POST",
        headers: { Authorization: "Bearer key", "MCP-Protocol-Version": "2026-07-28", "Mcp-Method": "tools/list" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
      }),
    );
    expect(res.status).toBe(400);
    expect((await res.json()).error.code).toBe(-32602);
    const ping = await modern(s(), "ping");
    expect(ping.status).toBe(404);
    expect(ping.body.error.code).toBe(-32601);
  });

  test("legacy clients still initialize", async () => {
    const r = await call(s(), ctx(), rpc("initialize", { protocolVersion: "2025-11-25" }), "2025-11-25");
    expect(r.body.result.protocolVersion).toBe("2025-11-25");
    // A legacy client asking for an unknown version gets the latest legacy one.
    const r2 = await call(s(), ctx(), rpc("initialize", { protocolVersion: "2026-07-28" }), "2025-06-18");
    expect(r2.body.result.protocolVersion).toBe("2025-11-25");
  });
});

describe("callToolResult", () => {
  test("structuredContent is still checked against returns", async () => {
    const { callToolResult } = await import("./index.js");
    const s = server({
      leak: tool({
        description: "leak",
        returns: v.object({ name: v.string() }),
        handler: async () =>
          callToolResult({
            content: [{ type: "text", text: "ok" }],
            structuredContent: { name: "x", secret: "s" },
          }) as any,
      }),
    });
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const r = await call(s, ctx(), rpc("tools/call", { name: "leak", arguments: {} }));
    spy.mockRestore();
    expect(r.body.result.isError).toBe(true);
    expect(JSON.stringify(r.body)).not.toContain("secret");
  });
});

describe("lint", () => {
  test("flags missing scopes and annotations", () => {
    const bare = new McpServer(components.mcp, {
      name: "x",
      version: "1",
      consentUrl: "https://app.example/connect",
      siteUrl: "https://site.example",
      tools: { t: tool({ description: "t", handler: async () => null }) },
    });
    const findings = bare.lint();
    expect(findings.some((f) => f.includes("No `scopes`"))).toBe(true);
    expect(findings.some((f) => f.includes('"t" has no annotations'))).toBe(true);
  });

  test("vMcpUser validates the user passed to internal functions", async () => {
    const { vMcpUser } = await import("./index.js");
    const { checkValue } = await import("./schema.js");
    const validator = vMcpUser();
    expect(checkValue(validator, { userId: "u", scopes: [], connectionId: "c" }).ok).toBe(true);
    expect(checkValue(validator, { userId: "u" }).ok).toBe(false);
  });
});
