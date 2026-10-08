import { defineSchema, defineTable } from "convex/server";
import { authTables } from "@convex-dev/auth/server";
import { v } from "convex/values";

export default defineSchema({
  ...authTables,
  // A todo list. Its owner can share it: anyone with `editorCode` or
  // `viewerCode` can join it with that role.
  lists: defineTable({
    name: v.string(),
    ownerId: v.id("users"),
    editorCode: v.string(),
    viewerCode: v.string(),
  })
    .index("ownerId", ["ownerId"])
    .index("editorCode", ["editorCode"])
    .index("viewerCode", ["viewerCode"]),
  listMembers: defineTable({
    listId: v.id("lists"),
    userId: v.id("users"),
    role: v.union(v.literal("viewer"), v.literal("editor")),
  })
    .index("list_user", ["listId", "userId"])
    .index("userId", ["userId"]),
  todos: defineTable({
    listId: v.id("lists"),
    text: v.string(),
    done: v.boolean(),
  })
    // Newest-first listing across all todos in a list.
    // eslint-disable-next-line @convex-dev/no-duplicate-indexes
    .index("listId", ["listId"])
    .index("list_done", ["listId", "done"]),
});
