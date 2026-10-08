import { v } from "convex/values";
import type { Doc, Id } from "./_generated/dataModel.js";
import type { MutationCtx } from "./_generated/server.js";
import { mutation, query } from "./_generated/server.js";

const LAST_USED_RESOLUTION_MS = 60_000;

export const tokenInfo = v.object({
  userId: v.string(),
  grantId: v.id("grants"),
  kind: v.union(v.literal("access"), v.literal("apiKey")),
  scopes: v.array(v.string()),
  resource: v.string(),
  clientId: v.optional(v.string()),
  // True when the caller should call `touch` to record recent use.
  stale: v.boolean(),
});

/**
 * Resolves a bearer credential (by hash) to the user it acts for. `now` is
 * an argument, not `Date.now()`, so a cached result can't outlive expiry.
 */
export const verify = query({
  args: { hash: v.string(), now: v.number() },
  returns: v.union(v.null(), tokenInfo),
  handler: async (ctx, args) => {
    const token = await ctx.db
      .query("tokens")
      .withIndex("hash", (q) => q.eq("hash", args.hash))
      .unique();
    if (!token || token.kind === "refresh") return null;
    if (token.expiresAt !== undefined && token.expiresAt <= args.now) {
      return null;
    }
    const grant = await ctx.db.get("grants", token.grantId);
    if (!grant) return null;
    return {
      userId: grant.userId,
      grantId: grant._id,
      kind: token.kind,
      scopes: grant.scopes,
      resource: grant.resource,
      clientId: grant.clientId,
      stale:
        grant.lastUsedAt === undefined ||
        grant.lastUsedAt < args.now - LAST_USED_RESOLUTION_MS,
    };
  },
});

/** Records that a grant was used. Callers only invoke it when `stale`. */
export const touch = mutation({
  args: { grantId: v.id("grants") },
  returns: v.null(),
  handler: async (ctx, args) => {
    const grant = await ctx.db.get("grants", args.grantId);
    if (
      grant &&
      (grant.lastUsedAt === undefined ||
        grant.lastUsedAt < Date.now() - LAST_USED_RESOLUTION_MS)
    ) {
      await ctx.db.patch("grants", grant._id, { lastUsedAt: Date.now() });
    }
    return null;
  },
});

export async function issueTokens(
  ctx: MutationCtx,
  grantId: Id<"grants">,
  args: {
    accessHash: string;
    refreshHash: string;
    accessTtlMs: number;
    refreshTtlMs: number;
  },
) {
  const now = Date.now();
  await ctx.db.insert("tokens", {
    hash: args.accessHash,
    grantId,
    kind: "access",
    expiresAt: now + args.accessTtlMs,
  });
  await ctx.db.insert("tokens", {
    hash: args.refreshHash,
    grantId,
    kind: "refresh",
    expiresAt: now + args.refreshTtlMs,
  });
}

/**
 * Deleting the grant is what revokes access: `verify` and `refresh` both
 * require it. Tokens are deleted here in a bounded batch; any left over
 * expire and are removed by the cleanup cron.
 */
export async function deleteGrant(ctx: MutationCtx, grant: Doc<"grants">) {
  await ctx.db.delete("grants", grant._id);
  const tokens = await ctx.db
    .query("tokens")
    .withIndex("grantId", (q) => q.eq("grantId", grant._id))
    .take(2000);
  for (const token of tokens) {
    await ctx.db.delete("tokens", token._id);
  }
}
