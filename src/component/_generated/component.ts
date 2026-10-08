/* eslint-disable */
/**
 * Generated `ComponentApi` utility.
 *
 * THIS CODE IS AUTOMATICALLY GENERATED.
 *
 * To regenerate, run `npx convex dev`.
 * @module
 */

import type { FunctionReference } from "convex/server";

/**
 * A utility for referencing a Convex component's exposed API.
 *
 * Useful when expecting a parameter like `components.myComponent`.
 * Usage:
 * ```ts
 * async function myFunction(ctx: QueryCtx, component: ComponentApi) {
 *   return ctx.runQuery(component.someFile.someQuery, { ...args });
 * }
 * ```
 */
export type ComponentApi<Name extends string | undefined = string | undefined> =
  {
    clients: {
      get: FunctionReference<
        "query",
        "internal",
        { clientId: string },
        null | {
          clientId: string;
          clientName?: string;
          clientUri?: string;
          logoUri?: string;
          redirectUris: Array<string>;
        },
        Name
      >;
      register: FunctionReference<
        "mutation",
        "internal",
        {
          clientId: string;
          clientName?: string;
          clientUri?: string;
          logoUri?: string;
          redirectUris: Array<string>;
        },
        { ok: true } | { ok: false; retryAfterMs: number },
        Name
      >;
      upsertMetadataDocument: FunctionReference<
        "mutation",
        "internal",
        {
          clientId: string;
          clientName?: string;
          clientUri?: string;
          logoUri?: string;
          redirectUris: Array<string>;
        },
        null,
        Name
      >;
    };
    grants: {
      createApiKey: FunctionReference<
        "mutation",
        "internal",
        {
          hash: string;
          name: string;
          resource: string;
          scopes: Array<string>;
          userId: string;
        },
        string,
        Name
      >;
      list: FunctionReference<
        "query",
        "internal",
        { userId: string },
        Array<{
          _creationTime: number;
          _id: string;
          clientId?: string;
          kind: "oauth" | "apiKey";
          lastUsedAt?: number;
          name: string;
          resource: string;
          scopes: Array<string>;
          userId: string;
        }>,
        Name
      >;
      revoke: FunctionReference<
        "mutation",
        "internal",
        { grantId: string; userId: string },
        boolean,
        Name
      >;
    };
    oauth: {
      createAuthRequest: FunctionReference<
        "mutation",
        "internal",
        {
          clientId: string;
          codeChallenge: string;
          redirectUri: string;
          requestId: string;
          resource: string;
          scopes: Array<string>;
          state?: string;
          ttlMs: number;
        },
        { ok: true } | { ok: false; retryAfterMs: number },
        Name
      >;
      decideAuthRequest: FunctionReference<
        "mutation",
        "internal",
        {
          approved: boolean;
          codeHash?: string;
          codeTtlMs: number;
          requestId: string;
          userId: string;
        },
        null | { redirectUri: string; state?: string },
        Name
      >;
      exchangeCode: FunctionReference<
        "mutation",
        "internal",
        {
          accessHash: string;
          accessTtlMs: number;
          clientId: string;
          codeHash: string;
          redirectUri: string;
          refreshHash: string;
          refreshTtlMs: number;
          resource?: string;
          verifierChallenge: string;
        },
        { ok: true; scopes: Array<string> } | { error: string; ok: false },
        Name
      >;
      getAuthRequest: FunctionReference<
        "query",
        "internal",
        { requestId: string },
        null | {
          clientId: string;
          clientName?: string;
          clientUri?: string;
          logoUri?: string;
          redirectUri: string;
          scopes: Array<string>;
          status: "pending" | "approved" | "denied";
        },
        Name
      >;
      refresh: FunctionReference<
        "mutation",
        "internal",
        {
          accessHash: string;
          accessTtlMs: number;
          clientId: string;
          newRefreshHash: string;
          refreshHash: string;
          refreshTtlMs: number;
          resource?: string;
        },
        { ok: true; scopes: Array<string> } | { error: string; ok: false },
        Name
      >;
      revokeToken: FunctionReference<
        "mutation",
        "internal",
        { clientId?: string; hash: string },
        null,
        Name
      >;
    };
    tokens: {
      touch: FunctionReference<
        "mutation",
        "internal",
        { grantId: string },
        null,
        Name
      >;
      verify: FunctionReference<
        "query",
        "internal",
        { hash: string; now: number },
        null | {
          clientId?: string;
          grantId: string;
          kind: "access" | "apiKey";
          resource: string;
          scopes: Array<string>;
          stale: boolean;
          userId: string;
        },
        Name
      >;
    };
  };
