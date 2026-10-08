// OAuth 2.1 authorization-code flow state. Plaintext secrets never reach
// these functions: the caller generates them and passes SHA-256 hashes.
import { v } from "convex/values";
import { mutation, query } from "./_generated/server.js";
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
  returns: v.null(),
  handler: async (ctx, { ttlMs, ...args }) => {
    await ctx.db.insert("authRequests", {
      ...args,
      status: "pending",
      expiresAt: Date.now() + ttlMs,
    });
    return null;
  },
});

/** What the consent page shows the signed-in user. */
export const getAuthRequest = query({
  args: { requestId: v.string() },
  returns: v.union(
    v.null(),
    v.object({
      clientId: v.string(),
      clientName: v.optional(v.string()),
      clientUri: v.optional(v.string()),
      logoUri: v.optional(v.string()),
      redirectUri: v.string(),
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
    if (!client) return null;
    return {
      clientId: client.clientId,
      clientName: client.clientName,
      clientUri: client.clientUri,
      logoUri: client.logoUri,
      redirectUri: request.redirectUri,
      scopes: request.scopes,
      status: request.status,
    };
  },
});

/**
 * Settles a pending request. On approval the authorization code (by hash) is
 * bound to the user; the caller redirects to `redirectUri` with the code.
 */
export const decideAuthRequest = mutation({
  args: {
    requestId: v.string(),
    userId: v.string(),
    approved: v.boolean(),
    codeHash: v.optional(v.string()),
    codeTtlMs: v.number(),
  },
  returns: v.union(
    v.null(),
    v.object({ redirectUri: v.string(), state: v.optional(v.string()) }),
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
    return { redirectUri: request.redirectUri, state: request.state };
  },
});

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
    // One grant per (user, client); re-authorizing replaces the old tokens.
    const existing = await ctx.db
      .query("grants")
      .withIndex("userId_clientId", (q) =>
        q.eq("userId", userId).eq("clientId", request.clientId),
      )
      .unique();
    if (existing) await deleteGrant(ctx, existing);
    const client = await ctx.db
      .query("clients")
      .withIndex("clientId", (q) => q.eq("clientId", request.clientId))
      .unique();
    const grantId = await ctx.db.insert("grants", {
      userId,
      kind: "oauth",
      clientId: request.clientId,
      name: client?.clientName ?? "MCP client",
      scopes: request.scopes,
      resource: request.resource,
    });
    await issueTokens(ctx, grantId, args);
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
    // Keep only the most recently rotated token for reuse detection.
    const previous = await ctx.db
      .query("tokens")
      .withIndex("grantId", (q) => q.eq("grantId", grant._id))
      .take(1000);
    for (const old of previous) {
      if (old.kind === "refresh" && old.rotatedAt !== undefined) {
        await ctx.db.delete("tokens", old._id);
      }
    }
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
