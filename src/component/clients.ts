import { v } from "convex/values";
import { mutation, query } from "./_generated/server.js";
import { rateLimiter, UNUSED_CLIENT_TTL_MS } from "./limits.js";

const clientFields = {
  clientId: v.string(),
  clientName: v.optional(v.string()),
  clientUri: v.optional(v.string()),
  logoUri: v.optional(v.string()),
  redirectUris: v.array(v.string()),
};

/**
 * Stores a client created by dynamic client registration (RFC 7591).
 * Rate limited; the client expires unless it completes an authorization.
 */
export const register = mutation({
  args: clientFields,
  returns: v.union(
    v.object({ ok: v.literal(true) }),
    v.object({ ok: v.literal(false), retryAfterMs: v.number() }),
  ),
  handler: async (ctx, args) => {
    const limit = await rateLimiter.limit(ctx, "registerClient");
    if (!limit.ok) return { ok: false as const, retryAfterMs: limit.retryAfter };
    await ctx.db.insert("clients", {
      ...args,
      expiresAt: Date.now() + UNUSED_CLIENT_TTL_MS,
    });
    return { ok: true as const };
  },
});

/** Caches a fetched client ID metadata document. */
export const upsertMetadataDocument = mutation({
  args: clientFields,
  returns: v.null(),
  handler: async (ctx, args) => {
    const existing = await ctx.db
      .query("clients")
      .withIndex("clientId", (q) => q.eq("clientId", args.clientId))
      .unique();
    if (existing) {
      await ctx.db.replace("clients", existing._id, args);
    } else {
      await ctx.db.insert("clients", args);
    }
    return null;
  },
});

export const get = query({
  args: { clientId: v.string() },
  returns: v.union(v.null(), v.object(clientFields)),
  handler: async (ctx, args) => {
    const client = await ctx.db
      .query("clients")
      .withIndex("clientId", (q) => q.eq("clientId", args.clientId))
      .unique();
    if (!client) return null;
    const { _id, _creationTime, expiresAt: _expiresAt, ...rest } = client;
    return rest;
  },
});
