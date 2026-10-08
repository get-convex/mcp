// OAuth 2.1 authorization-code and device (RFC 8628) flow state. Plaintext
// secrets never reach these functions: the caller generates them and passes
// SHA-256 hashes.
import { v } from "convex/values";
import type { MutationCtx } from "./_generated/server.js";
import { mutation, query } from "./_generated/server.js";
import { rateLimiter } from "./limits.js";
import { deleteGrant, issueTokens } from "./tokens.js";

const ttls = {
  accessTtlMs: v.number(),
  refreshTtlMs: v.number(),
};

const tokenResult = v.union(
  v.object({ ok: v.literal(true), scopes: v.array(v.string()) }),
  v.object({ ok: v.literal(false), error: v.string() }),
);

export const createAuthRequest = mutation({
  args: {
    requestId: v.string(),
    clientId: v.string(),
    redirectUri: v.string(),
    codeChallenge: v.string(),
    state: v.optional(v.string()),
    scopes: v.array(v.string()),
    resource: v.string(),
    ttlMs: v.number(),
  },
  returns: v.union(
    v.object({ ok: v.literal(true) }),
    v.object({ ok: v.literal(false), retryAfterMs: v.number() }),
  ),
  handler: async (ctx, { ttlMs, ...args }) => {
    for (const limit of [
      await rateLimiter.limit(ctx, "authRequestPerClient", { key: args.clientId }),
      await rateLimiter.limit(ctx, "authRequestGlobal"),
    ]) {
      if (!limit.ok) {
        return { ok: false as const, retryAfterMs: limit.retryAfter };
      }
    }
    await ctx.db.insert("authRequests", {
      ...args,
      status: "pending",
      expiresAt: Date.now() + ttlMs,
    });
    return { ok: true as const };
  },
});

/**
 * Starts a device authorization (RFC 8628). The agent shows the user a link
 * to the consent page and polls `pollDevice` with the device code.
 */
export const createDeviceRequest = mutation({
  args: {
    requestId: v.string(),
    clientId: v.string(),
    clientName: v.optional(v.string()),
    deviceCodeHash: v.string(),
    userCode: v.string(),
    scopes: v.array(v.string()),
    resource: v.string(),
    ttlMs: v.number(),
    intervalMs: v.number(),
  },
  returns: v.union(
    v.object({ ok: v.literal(true) }),
    v.object({ ok: v.literal(false), retryAfterMs: v.number() }),
  ),
  handler: async (ctx, { ttlMs, intervalMs, ...args }) => {
    for (const limit of [
      await rateLimiter.limit(ctx, "deviceRequest"),
      await rateLimiter.limit(ctx, "authRequestGlobal"),
    ]) {
      if (!limit.ok) {
        return { ok: false as const, retryAfterMs: limit.retryAfter };
      }
    }
    const taken = await ctx.db
      .query("authRequests")
      .withIndex("userCode", (q) => q.eq("userCode", args.userCode))
      .first();
    if (taken) throw new Error("user code collision; retry");
    await ctx.db.insert("authRequests", {
      ...args,
      kind: "device",
      status: "pending",
      pollIntervalMs: intervalMs,
      expiresAt: Date.now() + ttlMs,
    });
    return { ok: true as const };
  },
});

/**
 * Resolves a user code typed on the consent page to its request. A mutation
 * so attempts can be rate limited per signed-in user (RFC 8628 §5.1).
 */
export const findByUserCode = mutation({
  args: { userCode: v.string(), limitKey: v.string() },
  returns: v.union(
    v.object({ ok: v.literal(true), requestId: v.union(v.null(), v.string()) }),
    v.object({ ok: v.literal(false), retryAfterMs: v.number() }),
  ),
  handler: async (ctx, args) => {
    const limit = await rateLimiter.limit(ctx, "userCodeLookup", { key: args.limitKey });
    if (!limit.ok) return { ok: false as const, retryAfterMs: limit.retryAfter };
    const request = await ctx.db
      .query("authRequests")
      .withIndex("userCode", (q) => q.eq("userCode", args.userCode))
      .first();
    if (
      !request ||
      request.kind !== "device" ||
      request.status !== "pending" ||
      request.expiresAt <= Date.now()
    ) {
      return { ok: true as const, requestId: null };
    }
    return { ok: true as const, requestId: request.requestId };
  },
});

/** What the consent page shows the signed-in user. */
export const getAuthRequest = query({
  args: { requestId: v.string() },
  returns: v.union(
    v.null(),
    v.object({
      kind: v.union(v.literal("redirect"), v.literal("device")),
      clientId: v.string(),
      clientName: v.optional(v.string()),
      clientUri: v.optional(v.string()),
      logoUri: v.optional(v.string()),
      redirectUri: v.optional(v.string()),
      userCode: v.optional(v.string()),
      scopes: v.array(v.string()),
      status: v.union(
        v.literal("pending"),
        v.literal("approved"),
        v.literal("denied"),
      ),
    }),
  ),
  handler: async (ctx, args) => {
    const request = await ctx.db
      .query("authRequests")
      .withIndex("requestId", (q) => q.eq("requestId", args.requestId))
      .unique();
    if (!request || request.expiresAt <= Date.now()) return null;
    const client = await ctx.db
      .query("clients")
      .withIndex("clientId", (q) => q.eq("clientId", request.clientId))
      .unique();
    if (!client && request.kind !== "device") return null;
    const common = {
      clientId: request.clientId,
      scopes: request.scopes,
      status: request.status,
    };
    if (request.kind === "device") {
      return {
        ...common,
        kind: "device" as const,
        clientName: client?.clientName ?? request.clientName,
        userCode: request.userCode,
      };
    }
    return {
      ...common,
      kind: "redirect" as const,
      clientName: client?.clientName,
      clientUri: client?.clientUri,
      logoUri: client?.logoUri,
      redirectUri: request.redirectUri,
    };
  },
});

/**
 * Settles a pending request. For the code flow, approval binds the
 * authorization code (by hash) to the user and the caller redirects to
 * `redirectUri`. For the device flow, approval lets the agent's next poll
 * receive tokens.
 */
export const decideAuthRequest = mutation({
  args: {
    requestId: v.string(),
    userId: v.string(),
    approved: v.boolean(),
    codeHash: v.optional(v.string()),
    codeTtlMs: v.number(),
    // Device approvals must echo the user code the user confirmed matches
    // their agent, so a consent page that skips that step can't approve.
    confirmedUserCode: v.optional(v.string()),
  },
  returns: v.union(
    v.null(),
    v.object({
      kind: v.literal("redirect"),
      redirectUri: v.string(),
      state: v.optional(v.string()),
    }),
    v.object({ kind: v.literal("device"), confirmed: v.boolean() }),
  ),
  handler: async (ctx, args) => {
    const request = await ctx.db
      .query("authRequests")
      .withIndex("requestId", (q) => q.eq("requestId", args.requestId))
      .unique();
    if (
      !request ||
      request.status !== "pending" ||
      request.expiresAt <= Date.now()
    ) {
      return null;
    }
    if (request.kind === "device") {
      if (args.approved && args.confirmedUserCode !== request.userCode) {
        return { kind: "device" as const, confirmed: false };
      }
      await ctx.db.patch("authRequests", request._id, {
        status: args.approved ? "approved" : "denied",
        userId: args.userId,
      });
      return { kind: "device" as const, confirmed: true };
    }
    if (args.approved) {
      if (!args.codeHash) throw new Error("codeHash required to approve");
      await ctx.db.patch("authRequests", request._id, {
        status: "approved",
        userId: args.userId,
        codeHash: args.codeHash,
        expiresAt: Date.now() + args.codeTtlMs,
      });
    } else {
      await ctx.db.patch("authRequests", request._id, {
        status: "denied",
        userId: args.userId,
      });
    }
    return {
      kind: "redirect" as const,
      redirectUri: request.redirectUri,
      state: request.state,
    };
  },
});

/**
 * device_code grant (RFC 8628 §3.4/3.5): pending → authorization_pending
 * (or slow_down when polling faster than `intervalMs`), denied →
 * access_denied, expired → expired_token, approved → tokens, single use.
 */
export const pollDevice = mutation({
  args: {
    deviceCodeHash: v.string(),
    clientId: v.string(),
    accessHash: v.string(),
    accessTtlMs: v.number(),
  },
  returns: tokenResult,
  handler: async (ctx, args) => {
    const request = await ctx.db
      .query("authRequests")
      .withIndex("deviceCodeHash", (q) => q.eq("deviceCodeHash", args.deviceCodeHash))
      .unique();
    if (!request || request.kind !== "device" || request.clientId !== args.clientId) {
      return { ok: false as const, error: "invalid_grant" };
    }
    const now = Date.now();
    if (request.expiresAt <= now) {
      await ctx.db.delete("authRequests", request._id);
      return { ok: false as const, error: "expired_token" };
    }
    if (request.status === "denied") {
      await ctx.db.delete("authRequests", request._id);
      return { ok: false as const, error: "access_denied" };
    }
    if (request.status === "pending" || !request.userId) {
      // Every premature poll answers slow_down and adds 5s to this
      // request's minimum interval (RFC 8628 §3.5).
      const tooFast =
        request.lastPolledAt !== undefined &&
        now - request.lastPolledAt < request.pollIntervalMs;
      await ctx.db.patch("authRequests", request._id, {
        lastPolledAt: now,
        ...(tooFast ? { pollIntervalMs: request.pollIntervalMs + 5000 } : {}),
      });
      return {
        ok: false as const,
        error: tooFast ? "slow_down" : "authorization_pending",
      };
    }
    await ctx.db.delete("authRequests", request._id);
    const client = await ctx.db
      .query("clients")
      .withIndex("clientId", (q) => q.eq("clientId", request.clientId))
      .unique();
    // Device-flow tokens may end up in chat transcripts: access token only,
    // no refresh token. The agent runs the flow again when it expires.
    await createGrant(ctx, {
      userId: request.userId,
      clientId: request.clientId,
      name: client?.clientName ?? request.clientName ?? "Agent",
      scopes: request.scopes,
      resource: request.resource,
      tokens: { accessHash: args.accessHash, accessTtlMs: args.accessTtlMs },
    });
    return { ok: true as const, scopes: request.scopes };
  },
});

async function createGrant(
  ctx: MutationCtx,
  args: {
    userId: string;
    clientId: string;
    name: string;
    scopes: string[];
    resource: string;
    tokens: {
      accessHash: string;
      accessTtlMs: number;
      refreshHash?: string;
      refreshTtlMs?: number;
    };
  },
) {
  const grantId = await ctx.db.insert("grants", {
    userId: args.userId,
    kind: "oauth",
    clientId: args.clientId,
    name: args.name,
    scopes: args.scopes,
    resource: args.resource,
  });
  await issueTokens(ctx, grantId, args.tokens);
}

/** authorization_code grant. PKCE and redirect_uri are checked here. */
export const exchangeCode = mutation({
  args: {
    codeHash: v.string(),
    clientId: v.string(),
    redirectUri: v.string(),
    // base64url(SHA-256(code_verifier)), computed by the caller.
    verifierChallenge: v.string(),
    resource: v.optional(v.string()),
    accessHash: v.string(),
    refreshHash: v.string(),
    ...ttls,
  },
  returns: tokenResult,
  handler: async (ctx, args) => {
    const request = await ctx.db
      .query("authRequests")
      .withIndex("codeHash", (q) => q.eq("codeHash", args.codeHash))
      .unique();
    if (!request) return { ok: false as const, error: "invalid_grant" };
    // Single use: whatever happens next, this code is spent.
    await ctx.db.delete("authRequests", request._id);
    if (
      request.kind === "device" ||
      request.status !== "approved" ||
      !request.userId ||
      request.expiresAt <= Date.now() ||
      request.clientId !== args.clientId ||
      request.redirectUri !== args.redirectUri ||
      request.codeChallenge !== args.verifierChallenge ||
      (args.resource !== undefined && args.resource !== request.resource)
    ) {
      return { ok: false as const, error: "invalid_grant" };
    }
    const userId = request.userId;
    const client = await ctx.db
      .query("clients")
      .withIndex("clientId", (q) => q.eq("clientId", request.clientId))
      .unique();
    if (!client) return { ok: false as const, error: "invalid_grant" };
    // A client that completed an authorization is kept.
    if (client.expiresAt !== undefined) {
      await ctx.db.patch("clients", client._id, { expiresAt: undefined });
    }
    // Every authorization is its own connection: the same client (e.g. one
    // CIMD client ID used on several machines) can be connected many times.
    await createGrant(ctx, {
      userId,
      clientId: request.clientId,
      name: client.clientName ?? "MCP client",
      scopes: request.scopes,
      resource: request.resource,
      tokens: args,
    });
    return { ok: true as const, scopes: request.scopes };
  },
});

/** refresh_token grant with rotation and reuse detection. */
export const refresh = mutation({
  args: {
    refreshHash: v.string(),
    clientId: v.string(),
    resource: v.optional(v.string()),
    accessHash: v.string(),
    newRefreshHash: v.string(),
    ...ttls,
  },
  returns: tokenResult,
  handler: async (ctx, args) => {
    const token = await ctx.db
      .query("tokens")
      .withIndex("hash", (q) => q.eq("hash", args.refreshHash))
      .unique();
    if (!token || token.kind !== "refresh") {
      return { ok: false as const, error: "invalid_grant" };
    }
    const grant = await ctx.db.get("grants", token.grantId);
    if (!grant || grant.clientId !== args.clientId) {
      return { ok: false as const, error: "invalid_grant" };
    }
    if (token.rotatedAt !== undefined) {
      // A rotated refresh token was replayed: assume it leaked and kill the
      // whole connection (OAuth 2.1 §4.3.1).
      await deleteGrant(ctx, grant);
      return { ok: false as const, error: "invalid_grant" };
    }
    if (
      (token.expiresAt !== undefined && token.expiresAt <= Date.now()) ||
      (args.resource !== undefined && args.resource !== grant.resource)
    ) {
      return { ok: false as const, error: "invalid_grant" };
    }
    // Keep the rotated token (until it expires) to detect replays.
    await ctx.db.patch("tokens", token._id, { rotatedAt: Date.now() });
    await issueTokens(ctx, grant._id, {
      accessHash: args.accessHash,
      refreshHash: args.newRefreshHash,
      accessTtlMs: args.accessTtlMs,
      refreshTtlMs: args.refreshTtlMs,
    });
    return { ok: true as const, scopes: grant.scopes };
  },
});

/** RFC 7009. Revoking a refresh token ends the whole connection. */
export const revokeToken = mutation({
  args: { hash: v.string(), clientId: v.optional(v.string()) },
  returns: v.null(),
  handler: async (ctx, args) => {
    const token = await ctx.db
      .query("tokens")
      .withIndex("hash", (q) => q.eq("hash", args.hash))
      .unique();
    if (!token) return null;
    const grant = await ctx.db.get("grants", token.grantId);
    if (grant?.kind !== "oauth") return null;
    if (args.clientId !== undefined && grant.clientId !== args.clientId) {
      return null;
    }
    if (token.kind === "refresh") {
      await deleteGrant(ctx, grant);
    } else {
      await ctx.db.delete("tokens", token._id);
    }
    return null;
  },
});
