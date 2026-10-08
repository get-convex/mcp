/// <reference types="vite/client" />
import { test } from "vitest";
import schema from "./schema.js";
import { convexTest } from "convex-test";
import rateLimiter from "@convex-dev/rate-limiter/test";
export const modules = import.meta.glob("./**/*.*s");

export function initConvexTest() {
  const t = convexTest(schema, modules);
  rateLimiter.register(t, "rateLimiter");
  return t;
}
test("setup", () => {});
