// The app's authorization, in one place. Both the UI functions (lists.ts,
// todos.ts) and the functions behind MCP tools (mcpFunctions.ts) call these
// helpers inside their transaction, so the two paths can't drift apart.
//
// Swap the body of `roleFor` for another source of truth (a sharing
// component such as get-convex/shareable, an org/roles table, a projection of
// an external engine) without touching any caller.
import { ConvexError } from "convex/values";
import type { Doc, Id } from "./_generated/dataModel.js";
import type { QueryCtx } from "./_generated/server.js";

export type Role = "owner" | "editor" | "viewer";
export type Need = "view" | "edit" | "manage";

/**
 * Who is acting. `scopes` is set only for MCP connections: it can narrow,
 * never widen, what the user may do (a read-only agent acts as a viewer).
 */
export type Actor = { userId: Id<"users">; scopes?: string[] };

const allows: Record<Role, Need[]> = {
  owner: ["view", "edit", "manage"],
  editor: ["view", "edit"],
  viewer: ["view"],
};

// MCP scope → what that connection may do on top of the user's role.
const scopeAllows: Record<string, Need[]> = {
  "todos:read": ["view"],
  "todos:write": ["view", "edit"],
};

export async function roleFor(
  ctx: QueryCtx,
  userId: Id<"users">,
  list: Doc<"lists">,
): Promise<Role | null> {
  if (list.ownerId === userId) return "owner";
  const member = await ctx.db
    .query("listMembers")
    .withIndex("list_user", (q) => q.eq("listId", list._id).eq("userId", userId))
    .unique();
  return member?.role ?? null;
}

export function can(actor: Actor, role: Role | null, need: Need) {
  if (!role || !allows[role].includes(need)) return false;
  if (actor.scopes === undefined) return true;
  return actor.scopes.some((s) => scopeAllows[s]?.includes(need));
}

/**
 * Loads a list the actor may access at `need`, or throws. Not-found and
 * not-allowed throw the same error so list IDs can't be probed.
 */
export async function requireList(
  ctx: QueryCtx,
  actor: Actor,
  listId: string,
  need: Need,
) {
  const id = ctx.db.normalizeId("lists", listId);
  const list = id && (await ctx.db.get("lists", id));
  const role = list ? await roleFor(ctx, actor.userId, list) : null;
  if (!list || !can(actor, role, need)) {
    throw new ConvexError(`No list with id ${listId}`);
  }
  return { list, role: role! };
}

/** Loads a todo whose list the actor may access at `need`, or throws. */
export async function requireTodo(
  ctx: QueryCtx,
  actor: Actor,
  todoId: string,
  need: Need,
) {
  const id = ctx.db.normalizeId("todos", todoId);
  const todo = id && (await ctx.db.get("todos", id));
  if (!todo) throw new ConvexError(`No todo with id ${todoId}`);
  try {
    await requireList(ctx, actor, todo.listId, need);
  } catch {
    throw new ConvexError(`No todo with id ${todoId}`);
  }
  return todo;
}

/** Every list the user can see, with their role. */
export async function listsFor(ctx: QueryCtx, actor: Actor) {
  const owned = await ctx.db
    .query("lists")
    .withIndex("ownerId", (q) => q.eq("ownerId", actor.userId))
    .take(100);
  const memberships = await ctx.db
    .query("listMembers")
    .withIndex("userId", (q) => q.eq("userId", actor.userId))
    .take(100);
  const shared = [];
  for (const m of memberships) {
    const list = await ctx.db.get("lists", m.listId);
    if (list) shared.push({ list, role: m.role as Role });
  }
  return [...owned.map((list) => ({ list, role: "owner" as Role })), ...shared].filter(
    ({ role }) => can(actor, role, "view"),
  );
}
