import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

const authRequestCommon = {
  requestId: v.string(),
  clientId: v.string(),
  scopes: v.array(v.string()),
  resource: v.string(),
  expiresAt: v.number(),
  status: v.union(v.literal("pending"), v.literal("approved"), v.literal("denied")),
  userId: v.optional(v.string()),
};

export default defineSchema({
  // OAuth clients created through dynamic client registration (RFC 7591).
  clients: defineTable({
    clientId: v.string(),
    clientName: v.optional(v.string()),
    clientUri: v.optional(v.string()),
    logoUri: v.optional(v.string()),
    redirectUris: v.array(v.string()),
    // Set for DCR clients until their first successful authorization.
    expiresAt: v.optional(v.number()),
  })
    .index("clientId", ["clientId"])
    .index("expiresAt", ["expiresAt"]),

  // A pending authorization, waiting for the signed-in user to approve it on
  // the app's consent page. One of two kinds:
  // - redirect (OAuth authorization code): once approved it holds the hashed
  //   authorization code until it is exchanged.
  // - device (RFC 8628, for agents that can only make HTTP calls): the agent
  //   polls with the hashed device code until the user approves.
  authRequests: defineTable(
    v.union(
      v.object({
        ...authRequestCommon,
        kind: v.optional(v.literal("redirect")),
        redirectUri: v.string(),
        codeChallenge: v.string(),
        state: v.optional(v.string()),
        codeHash: v.optional(v.string()),
      }),
      v.object({
        ...authRequestCommon,
        kind: v.literal("device"),
        // Self-reported by the agent; shown as unverified.
        clientName: v.optional(v.string()),
        deviceCodeHash: v.string(),
        userCode: v.string(),
        pollIntervalMs: v.number(),
        lastPolledAt: v.optional(v.number()),
      }),
    ),
  )
    .index("requestId", ["requestId"])
    .index("codeHash", ["codeHash"])
    .index("deviceCodeHash", ["deviceCodeHash"])
    .index("userCode", ["userCode"])
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
    .index("userId", ["userId"]),

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
    // Set when a refresh token has been rotated. The row is kept until it
    // expires: presenting it again means the token family leaked, so the
    // whole grant is revoked.
    rotatedAt: v.optional(v.number()),
  })
    .index("hash", ["hash"])
    .index("grantId", ["grantId"])
    .index("expiresAt", ["expiresAt"]),
});
