import { McpServer, tool } from "@convex-dev/mcp";
import { getAuthUserId } from "@convex-dev/auth/server";
import { v } from "convex/values";
import { components, internal } from "./_generated/api.js";
import type { Id } from "./_generated/dataModel.js";

const todo = v.object({ id: v.string(), text: v.string(), done: v.boolean() });

export const mcp = new McpServer(components.mcp, {
  name: "todos",
  title: "Todos",
  version: "0.1.0",
  instructions: "Manage the signed-in user's todo list.",
  // Where /authorize sends the user to sign in and approve the agent.
  consentUrl: `${process.env.SITE_URL ?? "http://localhost:5173"}/connect`,
  scopes: {
    "todos:read": "See your todos",
    "todos:write": "Add, complete and delete your todos",
  },
  tools: {
    list_todos: tool({
      description:
        "List the user's todos, newest first, optionally filtered by completion. Returns at most `limit` (default 50, max 100).",
      args: { done: v.optional(v.boolean()), limit: v.optional(v.number()) },
      returns: v.object({ todos: v.array(todo) }),
      annotations: { readOnlyHint: true, openWorldHint: false },
      scope: "todos:read",
      handler: async (ctx, args, user) => ({
        todos: await ctx.runQuery(internal.todos.listForUser, {
          userId: user.userId as Id<"users">,
          ...args,
        }),
      }),
    }),
    add_todo: tool({
      description: "Add a todo for the user. Text is at most 1000 characters.",
      args: { text: v.string() },
      returns: todo,
      annotations: { destructiveHint: false, openWorldHint: false },
      scope: "todos:write",
      handler: (ctx, args, user) =>
        ctx.runMutation(internal.todos.addForUser, {
          userId: user.userId as Id<"users">,
          text: args.text,
        }),
    }),
    set_todo_done: tool({
      description: "Mark a todo as done or not done.",
      args: { id: v.string(), done: v.boolean() },
      returns: todo,
      annotations: { destructiveHint: false, idempotentHint: true, openWorldHint: false },
      scope: "todos:write",
      handler: (ctx, args, user) =>
        ctx.runMutation(internal.todos.setDoneForUser, {
          userId: user.userId as Id<"users">,
          ...args,
        }),
    }),
    delete_todo: tool({
      description: "Delete a todo permanently.",
      args: { id: v.string() },
      annotations: { destructiveHint: true, openWorldHint: false },
      scope: "todos:write",
      handler: async (ctx, args, user) => {
        await ctx.runMutation(internal.todos.removeForUser, {
          userId: user.userId as Id<"users">,
          id: args.id,
        });
        return `Deleted ${args.id}`;
      },
    }),
  },
});

// Backs the consent page (/connect) and the "Connected agents" panel.
// With Convex Auth, the users table ID is a stable, issuer-scoped user ID.
export const {
  getAuthRequest,
  authorize,
  listConnections,
  revokeConnection,
  createApiKey,
} = mcp.api({ getUserId: getAuthUserId });
