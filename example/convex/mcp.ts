import { createTool, McpServer } from "@convex-dev/mcp";
import { getAuthUserId } from "@convex-dev/auth/server";
import { v } from "convex/values";
import { components, internal } from "./_generated/api.js";
import type { Id } from "./_generated/dataModel.js";

// `user.userId` in handlers is typed as a users ID: no casts.
const tool = createTool<Id<"users">>();

const todo = v.object({
  id: v.string(),
  text: v.string(),
  done: v.boolean(),
  listId: v.string(),
});

export const mcp: McpServer<Id<"users">> = new McpServer(components.mcp, {
  name: "todos",
  title: "Todos",
  version: "0.2.0",
  instructions:
    "Manage the user's todo lists, including lists others shared with them. Call list_lists first to get list IDs; the user's role on a list (owner/editor/viewer) decides what they can change.",
  // Your frontend's consent page, where /authorize sends the user to sign in
  // and approve the agent. Set it explicitly: it's the page users see, which
  // isn't necessarily any other *_SITE_URL you already have.
  consentUrl: process.env.MCP_CONSENT_URL ?? "http://localhost:5173/connect",
  scopes: {
    "todos:read": "See your todo lists, including ones shared with you",
    "todos:write": "Add, complete and delete todos on lists you can edit",
  },
  tools: {
    list_lists: tool({
      description:
        "List the todo lists the user can see (their own and ones shared with them), with the user's role on each.",
      returns: v.object({
        lists: v.array(
          v.object({
            id: v.string(),
            name: v.string(),
            role: v.union(v.literal("owner"), v.literal("editor"), v.literal("viewer")),
          }),
        ),
      }),
      annotations: { readOnlyHint: true, openWorldHint: false },
      scope: "todos:read",
      handler: async (ctx, _args, user) => ({
        lists: await ctx.runQuery(internal.mcpFunctions.lists, { user }),
      }),
    }),
    list_todos: tool({
      description:
        "List todos on a list, newest first, optionally filtered by completion. Returns at most `limit` (default 50, max 100).",
      args: {
        listId: v.string(),
        done: v.optional(v.boolean()),
        limit: v.optional(v.number()),
      },
      returns: v.object({ todos: v.array(todo) }),
      annotations: { readOnlyHint: true, openWorldHint: false },
      scope: "todos:read",
      handler: async (ctx, args, user) => ({
        todos: await ctx.runQuery(internal.mcpFunctions.todos, { user, ...args }),
      }),
    }),
    add_todo: tool({
      description: "Add a todo to a list the user can edit. Text is at most 1000 characters.",
      args: { listId: v.string(), text: v.string() },
      returns: todo,
      annotations: { destructiveHint: false, openWorldHint: false },
      scope: "todos:write",
      handler: (ctx, args, user) =>
        ctx.runMutation(internal.mcpFunctions.add, { user, ...args }),
    }),
    set_todo_done: tool({
      description: "Mark a todo as done or not done.",
      args: { id: v.string(), done: v.boolean() },
      returns: todo,
      annotations: { destructiveHint: false, idempotentHint: true, openWorldHint: false },
      scope: "todos:write",
      handler: (ctx, args, user) =>
        ctx.runMutation(internal.mcpFunctions.setDone, { user, ...args }),
    }),
    delete_todo: tool({
      description: "Delete a todo permanently.",
      args: { id: v.string() },
      annotations: { destructiveHint: true, openWorldHint: false },
      scope: "todos:write",
      handler: async (ctx, args, user) => {
        await ctx.runMutation(internal.mcpFunctions.remove, { user, ...args });
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

// Operator/testing helpers, callable only with deploy credentials:
//   npx convex run mcp:createApiKeyForUser '{"userId":"<users id>"}'
export const { createApiKeyForUser } = mcp.internalApi();
