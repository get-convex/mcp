import { getAuthUserId } from "@convex-dev/auth/server";
import { ConvexError, v } from "convex/values";
import type { Id } from "./_generated/dataModel.js";
import {
  internalMutation,
  internalQuery,
  mutation,
  query,
} from "./_generated/server.js";
import type { MutationCtx, QueryCtx } from "./_generated/server.js";

// The app's own functions, used by the React UI.

export const list = query({
  args: {},
  handler: async (ctx) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) return [];
    return await listTodos(ctx, userId);
  },
});

export const add = mutation({
  args: { text: v.string() },
  handler: async (ctx, args) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) throw new ConvexError("Not signed in");
    return await ctx.db.insert("todos", { userId, text: args.text, done: false });
  },
});

export const toggle = mutation({
  args: { id: v.id("todos") },
  handler: async (ctx, args) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) throw new ConvexError("Not signed in");
    const todo = await ownTodo(ctx, userId, args.id);
    await ctx.db.patch("todos", todo._id, { done: !todo.done });
  },
});

// Internal versions for MCP tools. The MCP server passes the verified
// `userId` explicitly, since tool calls don't carry a Convex auth identity.

export const listForUser = internalQuery({
  args: { userId: v.id("users"), done: v.optional(v.boolean()) },
  handler: async (ctx, args) => {
    const todos = await listTodos(ctx, args.userId);
    return todos
      .filter((t) => args.done === undefined || t.done === args.done)
      .map((t) => ({ id: t._id, text: t.text, done: t.done }));
  },
});

export const addForUser = internalMutation({
  args: { userId: v.id("users"), text: v.string() },
  handler: async (ctx, args) => {
    const id = await ctx.db.insert("todos", {
      userId: args.userId,
      text: args.text,
      done: false,
    });
    return { id, text: args.text, done: false };
  },
});

export const setDoneForUser = internalMutation({
  args: { userId: v.id("users"), id: v.string(), done: v.boolean() },
  handler: async (ctx, args) => {
    const id = ctx.db.normalizeId("todos", args.id);
    if (!id) throw new ConvexError(`No todo with id ${args.id}`);
    const todo = await ownTodo(ctx, args.userId, id);
    await ctx.db.patch("todos", todo._id, { done: args.done });
    return { id: todo._id, text: todo.text, done: args.done };
  },
});

export const removeForUser = internalMutation({
  args: { userId: v.id("users"), id: v.string() },
  handler: async (ctx, args) => {
    const id = ctx.db.normalizeId("todos", args.id);
    if (!id) throw new ConvexError(`No todo with id ${args.id}`);
    const todo = await ownTodo(ctx, args.userId, id);
    await ctx.db.delete("todos", todo._id);
    return null;
  },
});

async function listTodos(ctx: QueryCtx, userId: Id<"users">) {
  return await ctx.db
    .query("todos")
    .withIndex("userId", (q) => q.eq("userId", userId))
    .take(500);
}

async function ownTodo(ctx: QueryCtx | MutationCtx, userId: Id<"users">, id: Id<"todos">) {
  const todo = await ctx.db.get("todos", id);
  if (!todo || todo.userId !== userId) {
    throw new ConvexError(`No todo with id ${id}`);
  }
  return todo;
}
