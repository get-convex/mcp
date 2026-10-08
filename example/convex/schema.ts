import { defineSchema, defineTable } from "convex/server";
import { authTables } from "@convex-dev/auth/server";
import { v } from "convex/values";

export default defineSchema({
  ...authTables,
  todos: defineTable({
    userId: v.id("users"),
    text: v.string(),
    done: v.boolean(),
  })
    // Newest-first listing across all todos.
    // eslint-disable-next-line @convex-dev/no-duplicate-indexes
    .index("userId", ["userId"])
    .index("userId_done", ["userId", "done"]),
});
