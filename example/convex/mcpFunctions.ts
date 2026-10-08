// Internal functions behind the MCP tools. They take the verified MCP user
// (`vMcpUser`), including the connection's scopes, and authorize with the
// same helpers as the UI — so a read-only connection acts as a viewer.
import { vMcpUser } from "@convex-dev/mcp";
import { v } from "convex/values";
import type { Doc } from "./_generated/dataModel.js";
import { internalMutation, internalQuery } from "./_generated/server.js";
import { listsFor, requireList, requireTodo } from "./access.js";
import { checkText } from "./todos.js";

const user = vMcpUser(v.id("users"));
const shape = (t: Doc<"todos">) => ({ id: t._id, text: t.text, done: t.done, listId: t.listId });

export const lists = internalQuery({
  args: { user },
  handler: async (ctx, args) =>
    (await listsFor(ctx, args.user)).map(({ list, role }) => ({
      id: list._id,
      name: list.name,
      role,
    })),
});

export const todos = internalQuery({
  args: {
    user,
    listId: v.string(),
    done: v.optional(v.boolean()),
    limit: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const { list } = await requireList(ctx, args.user, args.listId, "view");
    const limit = Math.min(Math.max(Math.floor(args.limit ?? 50), 1), 100);
    const done = args.done;
    const rows =
      done === undefined
        ? await ctx.db
            .query("todos")
            .withIndex("listId", (q) => q.eq("listId", list._id))
            .order("desc")
            .take(limit)
        : await ctx.db
            .query("todos")
            .withIndex("list_done", (q) => q.eq("listId", list._id).eq("done", done))
            .order("desc")
            .take(limit);
    return rows.map(shape);
  },
});

export const add = internalMutation({
  args: { user, listId: v.string(), text: v.string() },
  handler: async (ctx, args) => {
    const { list } = await requireList(ctx, args.user, args.listId, "edit");
    const text = checkText(args.text);
    const id = await ctx.db.insert("todos", { listId: list._id, text, done: false });
    return { id, text, done: false, listId: list._id };
  },
});

export const setDone = internalMutation({
  args: { user, id: v.string(), done: v.boolean() },
  handler: async (ctx, args) => {
    const todo = await requireTodo(ctx, args.user, args.id, "edit");
    await ctx.db.patch("todos", todo._id, { done: args.done });
    return shape({ ...todo, done: args.done });
  },
});

export const remove = internalMutation({
  args: { user, id: v.string() },
  handler: async (ctx, args) => {
    const todo = await requireTodo(ctx, args.user, args.id, "edit");
    await ctx.db.delete("todos", todo._id);
    return null;
  },
});
