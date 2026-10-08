import { describe, expect, test, vi, afterEach } from "vitest";
import { api, internal } from "./_generated/api.js";
import { initConvexTest } from "./setup.test.js";

const ttls = { accessTtlMs: 60_000, refreshTtlMs: 600_000 };

async function approvedCode(t: ReturnType<typeof initConvexTest>) {
  await t.mutation(api.clients.register, {
    clientId: "client1",
    clientName: "Agent",
    redirectUris: ["https://agent.example/cb"],
  });
  await t.mutation(api.oauth.createAuthRequest, {
    requestId: "req1",
    clientId: "client1",
    redirectUri: "https://agent.example/cb",
    codeChallenge: "challenge",
    state: "s",
    scopes: ["read"],
    resource: "https://app.example/mcp",
    ttlMs: 600_000,
  });
  const decided = await t.mutation(api.oauth.decideAuthRequest, {
    requestId: "req1",
    userId: "user1",
    approved: true,
    codeHash: "code1",
    codeTtlMs: 60_000,
  });
  expect(decided).toEqual({ redirectUri: "https://agent.example/cb", state: "s" });
}

const exchange = {
  codeHash: "code1",
  clientId: "client1",
  redirectUri: "https://agent.example/cb",
  verifierChallenge: "challenge",
  accessHash: "at1",
  refreshHash: "rt1",
  ...ttls,
};

describe("authorization code", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  test("exchanges once and issues tokens bound to the user", async () => {
    const t = initConvexTest();
    await approvedCode(t);
    expect(await t.mutation(api.oauth.exchangeCode, exchange)).toEqual({
      ok: true,
      scopes: ["read"],
    });
    expect(await t.query(api.tokens.verify, { hash: "at1", now: Date.now() })).toMatchObject({
      userId: "user1",
      scopes: ["read"],
      resource: "https://app.example/mcp",
      clientId: "client1",
    });
    // Refresh tokens are not bearer credentials for the MCP endpoint.
    expect(await t.query(api.tokens.verify, { hash: "rt1", now: Date.now() })).toBeNull();
    expect(
      await t.mutation(api.oauth.exchangeCode, { ...exchange, accessHash: "x", refreshHash: "y" }),
    ).toEqual({ ok: false, error: "invalid_grant" });
  });

  test("a wrong PKCE verifier burns the code", async () => {
    const t = initConvexTest();
    await approvedCode(t);
    expect(
      await t.mutation(api.oauth.exchangeCode, { ...exchange, verifierChallenge: "wrong" }),
    ).toEqual({ ok: false, error: "invalid_grant" });
    expect(await t.mutation(api.oauth.exchangeCode, exchange)).toEqual({
      ok: false,
      error: "invalid_grant",
    });
  });

  test("redirect_uri and client must match", async () => {
    const t = initConvexTest();
    await approvedCode(t);
    expect(
      await t.mutation(api.oauth.exchangeCode, { ...exchange, clientId: "other" }),
    ).toEqual({ ok: false, error: "invalid_grant" });
  });

  test("requests can only be decided once", async () => {
    const t = initConvexTest();
    await approvedCode(t);
    expect(
      await t.mutation(api.oauth.decideAuthRequest, {
        requestId: "req1",
        userId: "attacker",
        approved: true,
        codeHash: "code2",
        codeTtlMs: 60_000,
      }),
    ).toBeNull();
  });

  test("expired codes are rejected and cleaned up", async () => {
    vi.useFakeTimers();
    const t = initConvexTest();
    await approvedCode(t);
    vi.advanceTimersByTime(61_000);
    expect(await t.mutation(api.oauth.exchangeCode, exchange)).toEqual({
      ok: false,
      error: "invalid_grant",
    });
  });
});

describe("refresh tokens", () => {
  const refresh = (t: ReturnType<typeof initConvexTest>, refreshHash: string, n: number) =>
    t.mutation(api.oauth.refresh, {
      refreshHash,
      clientId: "client1",
      accessHash: `at${n}`,
      newRefreshHash: `rt${n}`,
      ...ttls,
    });

  test("rotate on every use", async () => {
    const t = initConvexTest();
    await approvedCode(t);
    await t.mutation(api.oauth.exchangeCode, exchange);
    expect((await refresh(t, "rt1", 2)).ok).toBe(true);
    expect((await refresh(t, "rt2", 3)).ok).toBe(true);
    expect(await t.query(api.tokens.verify, { hash: "at3", now: Date.now() })).not.toBeNull();
  });

  test("replaying any earlier generation revokes the connection", async () => {
    const t = initConvexTest();
    await approvedCode(t);
    await t.mutation(api.oauth.exchangeCode, exchange);
    await refresh(t, "rt1", 2);
    await refresh(t, "rt2", 3);
    await refresh(t, "rt3", 4);
    // rt1 is three generations old.
    expect(await refresh(t, "rt1", 5)).toEqual({ ok: false, error: "invalid_grant" });
    expect(await t.query(api.tokens.verify, { hash: "at4", now: Date.now() })).toBeNull();
    expect(await refresh(t, "rt4", 6)).toEqual({ ok: false, error: "invalid_grant" });
  });

  test("are bound to their client", async () => {
    const t = initConvexTest();
    await approvedCode(t);
    await t.mutation(api.oauth.exchangeCode, exchange);
    expect(
      await t.mutation(api.oauth.refresh, {
        refreshHash: "rt1",
        clientId: "other",
        accessHash: "a",
        newRefreshHash: "b",
        ...ttls,
      }),
    ).toEqual({ ok: false, error: "invalid_grant" });
  });
});

describe("connections", () => {
  test("authorizing the same client twice keeps both connections", async () => {
    const t = initConvexTest();
    await approvedCode(t);
    await t.mutation(api.oauth.exchangeCode, exchange);
    await t.mutation(api.oauth.createAuthRequest, {
      requestId: "req2",
      clientId: "client1",
      redirectUri: "https://agent.example/cb",
      codeChallenge: "challenge",
      scopes: [],
      resource: "https://app.example/mcp",
      ttlMs: 600_000,
    });
    await t.mutation(api.oauth.decideAuthRequest, {
      requestId: "req2",
      userId: "user1",
      approved: true,
      codeHash: "code2",
      codeTtlMs: 60_000,
    });
    await t.mutation(api.oauth.exchangeCode, {
      ...exchange,
      codeHash: "code2",
      accessHash: "at2",
      refreshHash: "rt2",
    });
    expect(await t.query(api.tokens.verify, { hash: "at1", now: Date.now() })).not.toBeNull();
    expect(await t.query(api.tokens.verify, { hash: "at2", now: Date.now() })).not.toBeNull();
    expect(await t.query(api.grants.list, { userId: "user1" })).toHaveLength(2);
  });

  test("access tokens stop verifying at expiry", async () => {
    const t = initConvexTest();
    await approvedCode(t);
    await t.mutation(api.oauth.exchangeCode, exchange);
    const later = Date.now() + ttls.accessTtlMs + 1;
    expect(await t.query(api.tokens.verify, { hash: "at1", now: later })).toBeNull();
  });
});

describe("grants", () => {
  test("API keys verify until revoked, only by their owner", async () => {
    const t = initConvexTest();
    const grantId = await t.mutation(api.grants.createApiKey, {
      userId: "user1",
      name: "CLI",
      scopes: [],
      resource: "https://app.example/mcp",
      hash: "key1",
    });
    expect(await t.query(api.tokens.verify, { hash: "key1", now: Date.now() })).toMatchObject({
      userId: "user1",
      kind: "apiKey",
    });
    expect(await t.mutation(api.grants.revoke, { userId: "user2", grantId })).toBe(false);
    expect(await t.mutation(api.grants.revoke, { userId: "user1", grantId: "junk" })).toBe(false);
    expect(await t.mutation(api.grants.revoke, { userId: "user1", grantId })).toBe(true);
    expect(await t.query(api.tokens.verify, { hash: "key1", now: Date.now() })).toBeNull();
  });
});

describe("rate limits", () => {
  test("client registration is rate limited", async () => {
    const t = initConvexTest();
    let limited = false;
    for (let i = 0; i < 40 && !limited; i++) {
      const r = await t.mutation(api.clients.register, {
        clientId: `c${i}`,
        redirectUris: ["https://agent.example/cb"],
      });
      limited = !r.ok;
    }
    expect(limited).toBe(true);
  });
});

describe("cleanup", () => {
  test("deletes clients that never completed an authorization", async () => {
    vi.useFakeTimers();
    const t = initConvexTest();
    await approvedCode(t); // client1, which completes an exchange below
    await t.mutation(api.oauth.exchangeCode, exchange);
    await t.mutation(api.clients.register, {
      clientId: "unused",
      redirectUris: ["https://agent.example/cb"],
    });
    vi.advanceTimersByTime(25 * 60 * 60 * 1000);
    await t.mutation(internal.crons.cleanup, {});
    expect(await t.query(api.clients.get, { clientId: "unused" })).toBeNull();
    expect(await t.query(api.clients.get, { clientId: "client1" })).not.toBeNull();
    vi.useRealTimers();
  });

  test("deletes expired tokens but keeps API keys", async () => {
    vi.useFakeTimers();
    const t = initConvexTest();
    await approvedCode(t);
    await t.mutation(api.oauth.exchangeCode, exchange);
    await t.mutation(api.grants.createApiKey, {
      userId: "user1",
      name: "CLI",
      scopes: [],
      resource: "https://app.example/mcp",
      hash: "key1",
    });
    vi.advanceTimersByTime(ttls.refreshTtlMs + 1);
    await t.mutation(internal.crons.cleanup, {});
    const tokens = await t.run((ctx) => ctx.db.query("tokens").collect());
    expect(tokens.map((x) => x.hash)).toEqual(["key1"]);
    vi.useRealTimers();
  });
});
