import { cronJobs } from "convex/server";
import { v } from "convex/values";
import { internal } from "./_generated/api.js";
import { internalMutation } from "./_generated/server.js";

const BATCH = 200;

/** Deletes expired auth requests, codes and tokens in bounded batches. */
export const cleanup = internalMutation({
  args: {},
  returns: v.null(),
  handler: async (ctx) => {
    const now = Date.now();
    const requests = await ctx.db
      .query("authRequests")
      .withIndex("expiresAt", (q) => q.lt("expiresAt", now))
      .take(BATCH);
    for (const r of requests) await ctx.db.delete("authRequests", r._id);
    // API keys have no expiresAt and are excluded by the range.
    const tokens = await ctx.db
      .query("tokens")
      .withIndex("expiresAt", (q) => q.gt("expiresAt", 0).lt("expiresAt", now))
      .take(BATCH);
    for (const t of tokens) await ctx.db.delete("tokens", t._id);
    if (requests.length === BATCH || tokens.length === BATCH) {
      await ctx.scheduler.runAfter(0, internal.crons.cleanup, {});
    }
    return null;
  },
});

const crons = cronJobs();
crons.interval("delete expired MCP credentials", { hours: 1 }, internal.crons.cleanup, {});
export default crons;
