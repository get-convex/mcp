import { HOUR, MINUTE, RateLimiter } from "@convex-dev/rate-limiter";
import { components } from "./_generated/api.js";

// Unauthenticated endpoints (DCR, /authorize) write to the database, so they
// are rate limited to bound abuse.
export const rateLimiter = new RateLimiter(components.rateLimiter, {
  registerClient: { kind: "token bucket", rate: 100, period: HOUR, capacity: 30 },
  authRequestGlobal: { kind: "token bucket", rate: 600, period: MINUTE, capacity: 200, shards: 4 },
  authRequestPerClient: { kind: "token bucket", rate: 20, period: MINUTE, capacity: 20 },
});

// Clients registered through DCR that never complete an authorization are
// deleted after this long.
export const UNUSED_CLIENT_TTL_MS = 24 * HOUR;
