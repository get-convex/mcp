// Converts Convex validators to JSON Schema (for MCP `inputSchema` /
// `outputSchema`) and checks untrusted JSON arguments against them.
// Only the validators' public properties (`kind`, `fields`, `element`, …)
// are used.
import type { GenericValidator, PropertyValidators } from "convex/values";
import { asObjectValidator } from "convex/values";

export type JSONSchema = { [key: string]: unknown };

export function toObjectValidator(
  args: PropertyValidators | GenericValidator,
): GenericValidator {
  const validator = asObjectValidator(args) as GenericValidator;
  if (validator.kind !== "object") {
    throw new Error("MCP tool args must be an object validator");
  }
  return validator;
}

export function toJsonSchema(validator: GenericValidator): JSONSchema {
  switch (validator.kind) {
    case "null":
      return { type: "null" };
    case "float64":
      return { type: "number" };
    case "int64":
      // int64 values travel over JSON as decimal strings.
      return { type: "string", pattern: "^-?[0-9]+$", format: "int64" };
    case "boolean":
      return { type: "boolean" };
    case "string":
      return { type: "string" };
    case "bytes":
      return { type: "string", contentEncoding: "base64" };
    case "any":
      return {};
    case "literal":
      return { const: toJsonValue(validator.value) };
    case "id":
      return {
        type: "string",
        description: `ID of a document in "${validator.tableName}"`,
      };
    case "array":
      return { type: "array", items: toJsonSchema(validator.element) };
    case "record":
      return {
        type: "object",
        additionalProperties: toJsonSchema(validator.value),
      };
    case "object": {
      const properties: Record<string, JSONSchema> = {};
      const required: string[] = [];
      for (const [key, field] of Object.entries(
        validator.fields as Record<string, GenericValidator>,
      )) {
        properties[key] = toJsonSchema(field);
        if (field.isOptional !== "optional") required.push(key);
      }
      return {
        type: "object",
        properties,
        ...(required.length ? { required } : {}),
        additionalProperties: false,
      };
    }
    case "union": {
      const members = validator.members as GenericValidator[];
      if (members.every((m) => m.kind === "literal")) {
        return {
          enum: members.map((m) =>
            toJsonValue((m as { value: unknown }).value),
          ),
        };
      }
      return { anyOf: members.map(toJsonSchema) };
    }
    default:
      // A validator kind added in a future Convex release: accept anything
      // rather than advertising a wrong schema.
      return {};
  }
}

export type CheckResult =
  | { ok: true; value: unknown }
  | { ok: false; error: string };

/**
 * Checks `value` against a validator and converts JSON encodings (int64
 * strings, base64 bytes) into Convex values. Returns the first mismatch as a
 * message instead of throwing so tool calls can report it to the model.
 */
export function checkValue(
  validator: GenericValidator,
  value: unknown,
  path = "arguments",
): CheckResult {
  const fail = (expected: string): CheckResult => ({
    ok: false,
    error: `${path}: expected ${expected}, got ${describe(value)}`,
  });
  switch (validator.kind) {
    case "null":
      return value === null ? { ok: true, value } : fail("null");
    case "float64":
      return typeof value === "number" ? { ok: true, value } : fail("number");
    case "int64":
      if (typeof value === "string" && /^-?[0-9]+$/.test(value)) {
        return { ok: true, value: BigInt(value) };
      }
      if (typeof value === "number" && Number.isSafeInteger(value)) {
        return { ok: true, value: BigInt(value) };
      }
      return fail("an integer");
    case "boolean":
      return typeof value === "boolean"
        ? { ok: true, value }
        : fail("boolean");
    case "string":
    case "id":
      return typeof value === "string" ? { ok: true, value } : fail("string");
    case "bytes": {
      if (typeof value !== "string") return fail("base64 string");
      try {
        const bin = atob(value);
        const bytes = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
        return { ok: true, value: bytes.buffer };
      } catch {
        return fail("base64 string");
      }
    }
    case "any":
      return { ok: true, value };
    case "literal": {
      const expected = toJsonValue(validator.value);
      if (value === expected) {
        return { ok: true, value: validator.value };
      }
      return fail(JSON.stringify(expected));
    }
    case "array": {
      if (!Array.isArray(value)) return fail("array");
      const out: unknown[] = [];
      for (let i = 0; i < value.length; i++) {
        const r = checkValue(validator.element, value[i], `${path}[${i}]`);
        if (!r.ok) return r;
        out.push(r.value);
      }
      return { ok: true, value: out };
    }
    case "record": {
      if (!isPlainObject(value)) return fail("object");
      const out: Record<string, unknown> = {};
      for (const [k, item] of Object.entries(value)) {
        const r = checkValue(validator.value, item, `${path}.${k}`);
        if (!r.ok) return r;
        out[k] = r.value;
      }
      return { ok: true, value: out };
    }
    case "object": {
      if (!isPlainObject(value)) return fail("object");
      const fields = validator.fields as Record<string, GenericValidator>;
      for (const key of Object.keys(value)) {
        if (!(key in fields)) {
          return { ok: false, error: `${path}: unexpected field "${key}"` };
        }
      }
      const out: Record<string, unknown> = {};
      for (const [key, field] of Object.entries(fields)) {
        const item = value[key];
        if (item === undefined) {
          if (field.isOptional === "optional") continue;
          return { ok: false, error: `${path}.${key}: required` };
        }
        const r = checkValue(field, item, `${path}.${key}`);
        if (!r.ok) return r;
        out[key] = r.value;
      }
      return { ok: true, value: out };
    }
    case "union": {
      const errors: string[] = [];
      for (const member of validator.members as GenericValidator[]) {
        const r = checkValue(member, value, path);
        if (r.ok) return r;
        errors.push(r.error);
      }
      return { ok: false, error: errors.join("; or ") };
    }
    default:
      // Unknown future kind: let Convex's own validation decide downstream.
      return { ok: true, value };
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function describe(value: unknown) {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  return typeof value;
}

/**
 * Makes a Convex value JSON-safe for MCP: bigint → decimal string,
 * ArrayBuffer → base64, undefined fields dropped, non-finite numbers → null.
 */
export function toJsonValue(value: unknown): unknown {
  if (typeof value === "bigint") return value.toString();
  if (typeof value === "number" && !Number.isFinite(value)) return null;
  if (value instanceof ArrayBuffer) {
    let bin = "";
    for (const b of new Uint8Array(value)) bin += String.fromCharCode(b);
    return btoa(bin);
  }
  if (Array.isArray(value)) return value.map(toJsonValue);
  if (isPlainObject(value)) {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      if (v !== undefined) out[k] = toJsonValue(v);
    }
    return out;
  }
  return value;
}
