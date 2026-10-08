import { getAuthUserId } from "@convex-dev/auth/server";
import { ConvexError, v } from "convex/values";
import { mutation, query } from "./_generated/server.js";
import type { MutationCtx, QueryCtx } from "./_generated/server.js";
import { requireList, requireTodo } from "./access.js";

// The app's own functions, used by the React UI. They use the same access
// helpers as the MCP tools (mcpFunctions.ts).

export const MAX_TEXT_LENGTH = 1000;

export function checkText(text: string) {
  const trimmed = text.trim();
  if (!trimmed) throw new ConvexError("Todo text can't be empty");
  if (trimmed.length > MAX_TEXT_LENGTH) {
    throw new ConvexError(`Todo text must be at most ${MAX_TEXT_LENGTH} characters`);
  }
  return trimmed;
}

async function actor(ctx: QueryCtx | MutationCtx) {
  const userId = await getAuthUserId(ctx);
  if (!userId) throw new ConvexError("Not signed in");
  return { userId };
}

export const list = query({
  args: { listId: v.string() },
  handler: async (ctx, args) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) return [];
    const { list } = await requireList(ctx, { userId }, args.listId, "view");
    return await ctx.db
      .query("todos")
      .withIndex("listId", (q) => q.eq("listId", list._id))
      .order("desc")
      .take(200);
  },
});

export const add = mutation({
  args: { listId: v.string(), text: v.string() },
  handler: async (ctx, args) => {
    const { list } = await requireList(ctx, await actor(ctx), args.listId, "edit");
    return await ctx.db.insert("todos", {
      listId: list._id,
      text: checkText(args.text),
      done: false,
    });
  },
});

export const toggle = mutation({
  args: { id: v.string() },
  handler: async (ctx, args) => {
    const todo = await requireTodo(ctx, await actor(ctx), args.id, "edit");
    await ctx.db.patch("todos", todo._id, { done: !todo.done });
  },
});
