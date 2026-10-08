import { getAuthUserId } from "@convex-dev/auth/server";
import { ConvexError, v } from "convex/values";
import { mutation, query } from "./_generated/server.js";
import type { MutationCtx, QueryCtx } from "./_generated/server.js";
import { listsFor, requireList } from "./access.js";

async function actor(ctx: QueryCtx | MutationCtx) {
  const userId = await getAuthUserId(ctx);
  if (!userId) throw new ConvexError("Not signed in");
  return { userId };
}

function code() {
  // Join codes are bearer secrets. Mutations get a seeded, per-execution
  // cryptographic RNG, so this is unpredictable to clients.
  return crypto.randomUUID().replace(/-/g, "").slice(0, 16);
}

export const mine = query({
  args: {},
  handler: async (ctx) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) return [];
    return (await listsFor(ctx, { userId })).map(({ list, role }) => ({
      id: list._id,
      name: list.name,
      role,
      // Only the owner sees the share codes.
      ...(role === "owner"
        ? { editorCode: list.editorCode, viewerCode: list.viewerCode }
        : {}),
    }));
  },
});

/** Creates the user's first list on first visit. */
export const ensureDefault = mutation({
  args: {},
  handler: async (ctx) => {
    const { userId } = await actor(ctx);
    const existing = await ctx.db
      .query("lists")
      .withIndex("ownerId", (q) => q.eq("ownerId", userId))
      .first();
    if (existing) return existing._id;
    return await ctx.db.insert("lists", {
      name: "My todos",
      ownerId: userId,
      editorCode: code(),
      viewerCode: code(),
    });
  },
});

export const create = mutation({
  args: { name: v.string() },
  handler: async (ctx, args) => {
    const { userId } = await actor(ctx);
    const name = args.name.trim().slice(0, 100);
    if (!name) throw new ConvexError("List name can't be empty");
    return await ctx.db.insert("lists", {
      name,
      ownerId: userId,
      editorCode: code(),
      viewerCode: code(),
    });
  },
});

/** Joins a list with a share code; the code decides the role. */
export const join = mutation({
  args: { code: v.string() },
  handler: async (ctx, args) => {
    const { userId } = await actor(ctx);
    const asEditor = await ctx.db
      .query("lists")
      .withIndex("editorCode", (q) => q.eq("editorCode", args.code))
      .unique();
    const asViewer = asEditor
      ? null
      : await ctx.db
          .query("lists")
          .withIndex("viewerCode", (q) => q.eq("viewerCode", args.code))
          .unique();
    const list = asEditor ?? asViewer;
    if (!list) throw new ConvexError("That share code isn't valid");
    if (list.ownerId === userId) return list._id;
    const role = asEditor ? "editor" : "viewer";
    const member = await ctx.db
      .query("listMembers")
      .withIndex("list_user", (q) => q.eq("listId", list._id).eq("userId", userId))
      .unique();
    if (member) await ctx.db.patch("listMembers", member._id, { role });
    else await ctx.db.insert("listMembers", { listId: list._id, userId, role });
    return list._id;
  },
});

/** Owner-only: rotates both share codes (existing members keep access). */
export const rotateCodes = mutation({
  args: { listId: v.string() },
  handler: async (ctx, args) => {
    const { list } = await requireList(ctx, await actor(ctx), args.listId, "manage");
    await ctx.db.patch("lists", list._id, { editorCode: code(), viewerCode: code() });
  },
});
