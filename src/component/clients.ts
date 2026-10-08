import { v } from "convex/values";
import { mutation, query } from "./_generated/server.js";

const clientValidator = v.object({
  clientId: v.string(),
  clientName: v.optional(v.string()),
  clientUri: v.optional(v.string()),
  logoUri: v.optional(v.string()),
  redirectUris: v.array(v.string()),
});

/**
 * Stores a client created by dynamic client registration (RFC 7591), or
 * refreshes the cached copy of a client ID metadata document.
 */
export const upsert = mutation({
  args: clientValidator.fields,
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
  returns: v.union(v.null(), clientValidator),
  handler: async (ctx, args) => {
    const client = await ctx.db
      .query("clients")
      .withIndex("clientId", (q) => q.eq("clientId", args.clientId))
      .unique();
    if (!client) return null;
    const { _id, _creationTime, ...rest } = client;
    return rest;
  },
});
