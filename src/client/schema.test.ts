import { describe, expect, test } from "vitest";
import { v } from "convex/values";
import { checkValue, toJsonSchema, toJsonValue, toObjectValidator } from "./schema.js";

describe("toJsonSchema", () => {
  test("objects, optional fields and nested types", () => {
    const args = toObjectValidator({
      text: v.string(),
      count: v.optional(v.number()),
      tags: v.array(v.string()),
      meta: v.record(v.string(), v.boolean()),
      priority: v.union(v.literal("low"), v.literal("high")),
      owner: v.union(v.null(), v.id("users")),
      big: v.int64(),
    });
    expect(toJsonSchema(args)).toEqual({
      type: "object",
      properties: {
        text: { type: "string" },
        count: { type: "number" },
        tags: { type: "array", items: { type: "string" } },
        meta: { type: "object", additionalProperties: { type: "boolean" } },
        priority: { enum: ["low", "high"] },
        owner: {
          anyOf: [
            { type: "null" },
            { type: "string", description: 'ID of a document in "users"' },
          ],
        },
        big: { type: "string", pattern: "^-?[0-9]+$", format: "int64" },
      },
      required: ["text", "tags", "meta", "priority", "owner", "big"],
      additionalProperties: false,
    });
  });

  test("empty args", () => {
    expect(toJsonSchema(toObjectValidator({}))).toEqual({
      type: "object",
      properties: {},
      additionalProperties: false,
    });
  });
});

describe("checkValue", () => {
  const args = toObjectValidator({
    text: v.string(),
    done: v.optional(v.boolean()),
    n: v.int64(),
    kind: v.union(v.literal("a"), v.literal("b")),
  });

  test("accepts valid values and decodes int64", () => {
    expect(checkValue(args, { text: "x", n: "12", kind: "a" })).toEqual({
      ok: true,
      value: { text: "x", n: 12n, kind: "a" },
    });
  });

  test("reports the first mismatch with a path", () => {
    expect(checkValue(args, { text: 1, n: "1", kind: "a" })).toEqual({
      ok: false,
      error: "arguments.text: expected string, got number",
    });
    expect(checkValue(args, { n: "1", kind: "a" })).toEqual({
      ok: false,
      error: "arguments.text: required",
    });
    expect(checkValue(args, { text: "x", n: "1", kind: "a", extra: 1 })).toMatchObject({
      ok: false,
      error: 'arguments: unexpected field "extra"',
    });
    expect(checkValue(args, { text: "x", n: "1", kind: "c" }).ok).toBe(false);
    expect(checkValue(args, "nope").ok).toBe(false);
  });

  test("bytes round-trip through base64", () => {
    const r = checkValue(v.bytes(), btoa("hi"));
    expect(r.ok).toBe(true);
    expect(toJsonValue((r as { value: ArrayBuffer }).value)).toBe(btoa("hi"));
  });
});

describe("toJsonValue", () => {
  test("makes Convex values JSON-safe", () => {
    expect(toJsonValue({ a: 1n, b: undefined, c: [NaN, "x"] })).toEqual({
      a: "1",
      c: [null, "x"],
    });
  });
});
