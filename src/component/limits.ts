import { HOUR, MINUTE, RateLimiter } from "@convex-dev/rate-limiter";
import { components } from "./_generated/api.js";

// Unauthenticated endpoints (DCR, /authorize) write to the database, so they
// are rate limited to bound abuse.
export const rateLimiter = new RateLimiter(components.rateLimiter, {
  registerClient: { kind: "token bucket", rate: 100, period: HOUR, capacity: 30 },
  authRequestGlobal: { kind: "token bucket", rate: 600, period: MINUTE, capacity: 200, shards: 4 },
  authRequestPerClient: { kind: "token bucket", rate: 20, period: MINUTE, capacity: 20 },
  // Device requests from agents share one built-in client, so they get their
  // own bucket rather than the per-client one.
  deviceRequest: { kind: "token bucket", rate: 120, period: MINUTE, capacity: 60 },
  // Typing a device user code on the consent page, per signed-in user.
  userCodeLookup: { kind: "token bucket", rate: 5, period: 10 * MINUTE, capacity: 5 },
});

// Clients registered through DCR that never complete an authorization are
// deleted after this long.
export const UNUSED_CLIENT_TTL_MS = 24 * HOUR;
