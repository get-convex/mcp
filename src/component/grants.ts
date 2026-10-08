// Connections between a user and an agent, for a "Connected agents" page.
import { v } from "convex/values";
import { mutation, query } from "./_generated/server.js";
import { deleteGrant } from "./tokens.js";

const grantValidator = v.object({
  _id: v.id("grants"),
  _creationTime: v.number(),
  userId: v.string(),
  kind: v.union(v.literal("oauth"), v.literal("apiKey")),
  clientId: v.optional(v.string()),
  name: v.string(),
  scopes: v.array(v.string()),
  resource: v.string(),
  lastUsedAt: v.optional(v.number()),
});

export const list = query({
  args: { userId: v.string() },
  returns: v.array(grantValidator),
  handler: async (ctx, args) => {
    return await ctx.db
      .query("grants")
      .withIndex("userId", (q) => q.eq("userId", args.userId))
      .order("desc")
      .take(200);
  },
});

/** Revokes a connection and all of its tokens. Scoped to the owner. */
export const revoke = mutation({
  args: { userId: v.string(), grantId: v.string() },
  returns: v.boolean(),
  handler: async (ctx, args) => {
    const grantId = ctx.db.normalizeId("grants", args.grantId);
    const grant = grantId && (await ctx.db.get("grants", grantId));
    if (!grant || grant.userId !== args.userId) return false;
    await deleteGrant(ctx, grant);
    return true;
  },
});

/** Stores a personal API key (by hash). It lives until revoked. */
export const createApiKey = mutation({
  args: {
    userId: v.string(),
    name: v.string(),
    scopes: v.array(v.string()),
    resource: v.string(),
    hash: v.string(),
  },
  returns: v.id("grants"),
  handler: async (ctx, args) => {
    const grantId = await ctx.db.insert("grants", {
      userId: args.userId,
      kind: "apiKey",
      name: args.name,
      scopes: args.scopes,
      resource: args.resource,
    });
    await ctx.db.insert("tokens", {
      hash: args.hash,
      grantId,
      kind: "apiKey",
    });
    return grantId;
  },
});
