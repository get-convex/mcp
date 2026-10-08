import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

export default defineSchema({
  // OAuth clients created through dynamic client registration (RFC 7591).
  clients: defineTable({
    clientId: v.string(),
    clientName: v.optional(v.string()),
    clientUri: v.optional(v.string()),
    logoUri: v.optional(v.string()),
    redirectUris: v.array(v.string()),
  }).index("clientId", ["clientId"]),

  // A pending /authorize request, waiting for the signed-in user to approve
  // it on the app's consent page. Once approved it holds the (hashed)
  // authorization code until it is exchanged.
  authRequests: defineTable({
    requestId: v.string(),
    clientId: v.string(),
    redirectUri: v.string(),
    codeChallenge: v.string(),
    state: v.optional(v.string()),
    scopes: v.array(v.string()),
    resource: v.string(),
    expiresAt: v.number(),
    status: v.union(
      v.literal("pending"),
      v.literal("approved"),
      v.literal("denied"),
    ),
    userId: v.optional(v.string()),
    codeHash: v.optional(v.string()),
  })
    .index("requestId", ["requestId"])
    .index("codeHash", ["codeHash"])
    .index("expiresAt", ["expiresAt"]),

  // One connection between a user and an agent: an OAuth client the user
  // approved, or a personal API key. Revoking a grant revokes its tokens.
  grants: defineTable({
    userId: v.string(),
    kind: v.union(v.literal("oauth"), v.literal("apiKey")),
    clientId: v.optional(v.string()),
    name: v.string(),
    scopes: v.array(v.string()),
    resource: v.string(),
    lastUsedAt: v.optional(v.number()),
  })
    .index("userId", ["userId"])
    .index("userId_clientId", ["userId", "clientId"]),

  tokens: defineTable({
    hash: v.string(),
    grantId: v.id("grants"),
    kind: v.union(
      v.literal("access"),
      v.literal("refresh"),
      v.literal("apiKey"),
    ),
    // Absent for API keys, which live until revoked.
    expiresAt: v.optional(v.number()),
    // Set when a refresh token has been rotated. Presenting it again means
    // it leaked, so the whole grant is revoked.
    rotatedAt: v.optional(v.number()),
  })
    .index("hash", ["hash"])
    .index("grantId", ["grantId"])
    .index("expiresAt", ["expiresAt"]),
});
