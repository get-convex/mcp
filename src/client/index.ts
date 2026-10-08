import {
  actionGeneric,
  httpActionGeneric,
  mutationGeneric,
  queryGeneric,
} from "convex/server";
import type {
  Auth,
  GenericActionCtx,
  GenericDataModel,
  HttpRouter,
} from "convex/server";
import { ConvexError, v } from "convex/values";
import type {
  GenericValidator,
  Infer,
  ObjectType,
  PropertyValidators,
} from "convex/values";
import type { ComponentApi } from "../component/_generated/component.js";
import { randomToken, sha256Base64Url, sha256Hex, TOKEN_PREFIX } from "../shared.js";
import { checkValue, toJsonSchema, toJsonValue, toObjectValidator } from "./schema.js";
import type { JSONSchema } from "./schema.js";

export { toJsonSchema, checkValue } from "./schema.js";

// ---------------------------------------------------------------------------
// Tool definitions

/** The `ctx` tool handlers receive: an HTTP action context. */
export type ToolCtx = GenericActionCtx<GenericDataModel>;

/**
 * Who a tool call acts for. `userId` comes from a verified credential: it is
 * the value your `getUserId` returned when the user connected the agent.
 */
export type McpUser = {
  userId: string;
  scopes: string[];
  /** The OAuth client ID, or undefined for personal API keys. */
  clientId?: string;
  connectionId: string;
};

/** https://modelcontextprotocol.io/specification/2025-11-25/server/tools */
export type ToolAnnotations = {
  title?: string;
  readOnlyHint?: boolean;
  destructiveHint?: boolean;
  idempotentHint?: boolean;
  openWorldHint?: boolean;
};

export type ContentBlock =
  | { type: "text"; text: string }
  | { type: "image"; data: string; mimeType: string }
  | { type: "audio"; data: string; mimeType: string }
  | {
      type: "resource_link";
      uri: string;
      name: string;
      description?: string;
      mimeType?: string;
    };

export type CallToolResult = {
  content: ContentBlock[];
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
};

const RESULT = Symbol("mcpCallToolResult");

/**
 * Return this from a handler to control the MCP result exactly (images,
 * multiple content blocks, `isError`).
 */
export function callToolResult(result: CallToolResult) {
  return { [RESULT]: true, ...result } as CallToolResult & { [RESULT]: true };
}

export type ToolDefinition<
  Args extends PropertyValidators = PropertyValidators,
  Returns extends GenericValidator | undefined = GenericValidator | undefined,
> = {
  /** Human-friendly display name. */
  title?: string;
  /** What the tool does, written for the model. */
  description: string;
  /** Convex validators for the arguments; exposed as `inputSchema`. */
  args?: Args;
  /** Optional validator for the result; exposed as `outputSchema`. */
  returns?: Returns;
  annotations?: ToolAnnotations;
  /**
   * OAuth scope required to see and call this tool. Must be one of the
   * server's `scopes`. Tools without a scope are available to every
   * connection.
   */
  scope?: string;
  handler: (
    ctx: ToolCtx,
    args: ObjectType<Args>,
    user: McpUser,
  ) => Promise<
    | (Returns extends GenericValidator ? Infer<Returns> : unknown)
    | ReturnType<typeof callToolResult>
  >;
};

/** Defines a tool. Identity helper that gives `handler` typed `args`. */
export function tool<
  Args extends PropertyValidators = Record<string, never>,
  Returns extends GenericValidator | undefined = undefined,
>(definition: ToolDefinition<Args, Returns>): ToolDefinition<any, any> {
  return definition as ToolDefinition<any, any>;
}

// ---------------------------------------------------------------------------
// Server

export type McpServerOptions = {
  /** Server name reported to clients in `serverInfo`. */
  name: string;
  version: string;
  title?: string;
  /** Guidance for the model on how to use this server's tools. */
  instructions?: string;
  tools: Record<string, ToolDefinition<any, any>>;
  /**
   * Your app's consent page. Users are sent to `${consentUrl}?request=<id>`;
   * the page signs them in, shows `getAuthRequest`, and calls `authorize`.
   */
  consentUrl: string;
  /**
   * Public origin of your Convex HTTP actions, e.g. a custom domain.
   * Defaults to `process.env.CONVEX_SITE_URL`.
   */
  siteUrl?: string;
  /** Path of the MCP endpoint. Default "/mcp". */
  path?: string;
  /** Optional OAuth scopes, mapped to a description for the consent page. */
  scopes?: Record<string, string>;
  /**
   * Browser origins allowed to call the MCP endpoint directly. Requests with
   * any other `Origin` header are rejected (DNS rebinding protection).
   * Agents calling from servers send no Origin and are unaffected.
   */
  allowedOrigins?: string[];
  accessTokenTtlMs?: number;
  refreshTokenTtlMs?: number;
};

export const PROTOCOL_VERSIONS = ["2025-11-25", "2025-06-18", "2025-03-26"];
const LATEST_PROTOCOL_VERSION = PROTOCOL_VERSIONS[0];

const AUTH_REQUEST_TTL_MS = 10 * 60_000;
const CODE_TTL_MS = 60_000;
const DEFAULT_ACCESS_TTL_MS = 60 * 60_000;
const DEFAULT_REFRESH_TTL_MS = 30 * 24 * 60 * 60_000;

type CompiledTool = {
  name: string;
  definition: ToolDefinition<any, any>;
  args: GenericValidator;
  returns?: GenericValidator;
  listing: Record<string, unknown>;
};

export class McpServer {
  private readonly tools: Map<string, CompiledTool>;
  readonly path: string;

  constructor(
    public component: ComponentApi,
    public options: McpServerOptions,
  ) {
    this.path = normalizePath(options.path ?? "/mcp");
    this.tools = new Map();
    for (const [name, definition] of Object.entries(options.tools)) {
      if (!/^[A-Za-z0-9_.-]{1,128}$/.test(name)) {
        throw new Error(`Invalid MCP tool name "${name}"`);
      }
      if (definition.scope && !options.scopes?.[definition.scope]) {
        throw new Error(
          `Tool "${name}" requires scope "${definition.scope}", which is not in \`scopes\``,
        );
      }
      const args = toObjectValidator(definition.args ?? {});
      const returns: GenericValidator | undefined = definition.returns;
      const outputSchema = returns && toJsonSchema(returns);
      this.tools.set(name, {
        name,
        definition,
        args,
        returns,
        listing: {
          name,
          ...(definition.title ? { title: definition.title } : {}),
          description: definition.description,
          inputSchema: toJsonSchema(args),
          ...(outputSchema?.type === "object" ? { outputSchema } : {}),
          ...(definition.annotations
            ? { annotations: definition.annotations }
            : {}),
        },
      });
    }
  }

  // ---- URLs ---------------------------------------------------------------

  /** The origin clients use, without a trailing slash. */
  get siteUrl(): string {
    const url = this.options.siteUrl ?? process.env.CONVEX_SITE_URL;
    if (!url) {
      throw new Error("McpServer: set `siteUrl` or CONVEX_SITE_URL");
    }
    return url.replace(/\/+$/, "");
  }
  /** The MCP server URL users paste into their agent. */
  get resource(): string {
    return this.siteUrl + this.path;
  }
  /** The authorization server issuer: the site origin (RFC 8414). */
  get issuer(): string {
    return this.siteUrl;
  }
  private get oauthBase() {
    return `${this.siteUrl}${this.path}/oauth`;
  }
  private get resourceMetadataUrl() {
    return `${this.siteUrl}/.well-known/oauth-protected-resource${this.path}`;
  }
  private get scopeNames(): string[] {
    return Object.keys(this.options.scopes ?? {});
  }

  // ---- Routes -------------------------------------------------------------

  /**
   * Registers the MCP endpoint, OAuth endpoints and discovery documents on
   * your app's HTTP router. Your app's `convex.config.ts` must not set an
   * `httpPrefix`: discovery documents live at the origin root.
   */
  registerRoutes(http: HttpRouter) {
    const route = (
      path: string,
      method: "GET" | "POST" | "DELETE" | "OPTIONS",
      handler: (ctx: ToolCtx, request: Request) => Promise<Response>,
    ) =>
      http.route({
        path,
        method,
        handler: httpActionGeneric(handler as any),
      });
    const p = this.path;

    route(p, "POST", (ctx, req) => this.handleMcp(ctx, req));
    route(p, "GET", async (_ctx, req) =>
      this.mcpCors(req, new Response(null, { status: 405, headers: { Allow: "POST" } })),
    );
    route(p, "DELETE", async (_ctx, req) =>
      this.mcpCors(req, new Response(null, { status: 405, headers: { Allow: "POST" } })),
    );
    route(p, "OPTIONS", async (_ctx, req) =>
      this.mcpCors(req, new Response(null, { status: 204 })),
    );

    const prm = async () => json(this.protectedResourceMetadata(), 200, PUBLIC_CORS);
    const asm = async () => json(this.authorizationServerMetadata(), 200, PUBLIC_CORS);
    for (const path of [
      `/.well-known/oauth-protected-resource${p}`,
      `/.well-known/oauth-protected-resource`,
    ]) {
      route(path, "GET", prm);
      route(path, "OPTIONS", preflight);
    }
    route(`/.well-known/oauth-authorization-server`, "GET", asm);
    route(`/.well-known/oauth-authorization-server`, "OPTIONS", preflight);

    route(`${p}/oauth/register`, "POST", (ctx, req) => this.handleRegister(ctx, req));
    route(`${p}/oauth/register`, "OPTIONS", preflight);
    route(`${p}/oauth/authorize`, "GET", (ctx, req) => this.handleAuthorize(ctx, req));
    route(`${p}/oauth/token`, "POST", (ctx, req) => this.handleToken(ctx, req));
    route(`${p}/oauth/token`, "OPTIONS", preflight);
    route(`${p}/oauth/revoke`, "POST", (ctx, req) => this.handleRevoke(ctx, req));
    route(`${p}/oauth/revoke`, "OPTIONS", preflight);
  }

  protectedResourceMetadata() {
    return {
      resource: this.resource,
      authorization_servers: [this.issuer],
      bearer_methods_supported: ["header"],
      resource_name: this.options.title ?? this.options.name,
      ...(this.scopeNames.length ? { scopes_supported: this.scopeNames } : {}),
    };
  }

  authorizationServerMetadata() {
    const base = this.oauthBase;
    return {
      issuer: this.issuer,
      authorization_endpoint: `${base}/authorize`,
      token_endpoint: `${base}/token`,
      registration_endpoint: `${base}/register`,
      revocation_endpoint: `${base}/revoke`,
      response_types_supported: ["code"],
      response_modes_supported: ["query"],
      grant_types_supported: ["authorization_code", "refresh_token"],
      token_endpoint_auth_methods_supported: ["none"],
      revocation_endpoint_auth_methods_supported: ["none"],
      code_challenge_methods_supported: ["S256"],
      client_id_metadata_document_supported: true,
      authorization_response_iss_parameter_supported: true,
      ...(this.scopeNames.length ? { scopes_supported: this.scopeNames } : {}),
    };
  }

  // ---- MCP endpoint -------------------------------------------------------

  private mcpCors(request: Request, response: Response): Response {
    const origin = request.headers.get("Origin");
    if (origin && this.options.allowedOrigins?.includes(origin)) {
      response.headers.set("Access-Control-Allow-Origin", origin);
      response.headers.set("Vary", "Origin");
      response.headers.set("Access-Control-Allow-Methods", "POST, OPTIONS");
      response.headers.set(
        "Access-Control-Allow-Headers",
        "Authorization, Content-Type, Accept, MCP-Protocol-Version, Mcp-Session-Id, Last-Event-ID",
      );
      response.headers.set(
        "Access-Control-Expose-Headers",
        "WWW-Authenticate, Mcp-Session-Id",
      );
    }
    return response;
  }

  private unauthorized(error?: "invalid_token", description?: string) {
    const params = [`resource_metadata="${this.resourceMetadataUrl}"`];
    if (error) params.push(`error="${error}"`);
    if (description) params.push(`error_description="${description}"`);
    if (this.scopeNames.length) params.push(`scope="${this.scopeNames.join(" ")}"`);
    return json({ error: error ?? "unauthorized" }, 401, {
      "WWW-Authenticate": `Bearer ${params.join(", ")}`,
    });
  }

  /** Verifies the bearer credential on an MCP request. */
  async authenticate(ctx: ToolCtx, request: Request): Promise<McpUser | null> {
    const header = request.headers.get("Authorization");
    const match = header?.match(/^Bearer\s+(\S+)$/i);
    if (!match) return null;
    const info = await ctx.runQuery(this.component.tokens.verify, {
      hash: await sha256Hex(match[1]),
    });
    // Tokens are audience-bound to this server (RFC 8707).
    if (!info || info.resource !== this.resource) return null;
    if (info.stale) {
      await ctx.runMutation(this.component.tokens.touch, {
        grantId: info.grantId,
      });
    }
    return {
      userId: info.userId,
      scopes: info.scopes,
      clientId: info.clientId,
      connectionId: info.grantId,
    };
  }

  async handleMcp(ctx: ToolCtx, request: Request): Promise<Response> {
    const origin = request.headers.get("Origin");
    if (origin && !this.options.allowedOrigins?.includes(origin)) {
      return json(rpcError(null, -32000, "Origin not allowed"), 403);
    }
    const respond = (r: Response) => this.mcpCors(request, r);

    const user = await this.authenticate(ctx, request);
    if (!user) {
      const hasToken = request.headers.has("Authorization");
      return respond(
        this.unauthorized(hasToken ? "invalid_token" : undefined),
      );
    }

    // Absent header means 2025-03-26 (Streamable HTTP §Protocol Version Header).
    const headerVersion = request.headers.get("MCP-Protocol-Version");
    if (headerVersion && !PROTOCOL_VERSIONS.includes(headerVersion)) {
      return respond(
        json(
          rpcError(null, -32600, `Unsupported MCP-Protocol-Version: ${headerVersion}`),
          400,
        ),
      );
    }

    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return respond(json(rpcError(null, -32700, "Parse error"), 400));
    }

    const batch = Array.isArray(body);
    if (batch && headerVersion && headerVersion !== "2025-03-26") {
      return respond(
        json(rpcError(null, -32600, "JSON-RPC batching is not supported"), 400),
      );
    }
    const messages = batch ? (body as unknown[]) : [body];
    if (messages.length === 0) {
      return respond(json(rpcError(null, -32600, "Invalid Request"), 400));
    }

    const responses: unknown[] = [];
    for (const message of messages) {
      const result = await this.handleMessage(ctx, message, user);
      if (result instanceof Response) return respond(result);
      if (result !== undefined) responses.push(result);
    }
    if (responses.length === 0) {
      // Only notifications or responses: 202 with no body.
      return respond(new Response(null, { status: 202 }));
    }
    return respond(json(batch ? responses : responses[0], 200));
  }

  private async handleMessage(
    ctx: ToolCtx,
    message: unknown,
    user: McpUser,
  ): Promise<unknown | Response | undefined> {
    if (!isObject(message) || message.jsonrpc !== "2.0") {
      return rpcError(null, -32600, "Invalid Request");
    }
    const { id, method, params } = message as {
      id?: string | number | null;
      method?: unknown;
      params?: unknown;
    };
    if (typeof method !== "string") {
      // A response to a server request, which we never send. Accept it.
      return undefined;
    }
    const isNotification = id === undefined;
    if (isNotification) return undefined;
    if (typeof id !== "string" && typeof id !== "number") {
      return rpcError(null, -32600, "Invalid Request");
    }
    const p = isObject(params) ? params : {};

    switch (method) {
      case "initialize": {
        const requested = p.protocolVersion;
        const protocolVersion =
          typeof requested === "string" && PROTOCOL_VERSIONS.includes(requested)
            ? requested
            : LATEST_PROTOCOL_VERSION;
        return rpcResult(id, {
          protocolVersion,
          capabilities: { tools: { listChanged: false } },
          serverInfo: {
            name: this.options.name,
            version: this.options.version,
            ...(this.options.title ? { title: this.options.title } : {}),
          },
          ...(this.options.instructions
            ? { instructions: this.options.instructions }
            : {}),
        });
      }
      case "ping":
        return rpcResult(id, {});
      case "tools/list":
        return rpcResult(id, {
          tools: [...this.tools.values()]
            .filter((t) => this.allowed(t, user))
            .map((t) => t.listing),
        });
      case "tools/call": {
        const name = p.name;
        const t = typeof name === "string" ? this.tools.get(name) : undefined;
        if (!t) return rpcError(id, -32602, `Unknown tool: ${String(name)}`);
        if (!this.allowed(t, user)) {
          return this.insufficientScope(t.definition.scope!);
        }
        return rpcResult(id, await this.callTool(ctx, t, p.arguments ?? {}, user));
      }
      default:
        return rpcError(id, -32601, `Method not found: ${method}`);
    }
  }

  private allowed(t: CompiledTool, user: McpUser) {
    return !t.definition.scope || user.scopes.includes(t.definition.scope);
  }

  private insufficientScope(scope: string) {
    return json({ error: "insufficient_scope" }, 403, {
      "WWW-Authenticate": `Bearer error="insufficient_scope", scope="${scope}", resource_metadata="${this.resourceMetadataUrl}"`,
    });
  }

  private async callTool(
    ctx: ToolCtx,
    t: CompiledTool,
    rawArgs: unknown,
    user: McpUser,
  ): Promise<CallToolResult> {
    // Validation failures are tool errors so the model can fix its call.
    const checked = checkValue(t.args, rawArgs);
    if (!checked.ok) {
      return errorResult(`Invalid arguments: ${checked.error}`);
    }
    let value: unknown;
    try {
      value = await t.definition.handler(ctx, checked.value as any, user);
    } catch (error) {
      if (error instanceof ConvexError) {
        const data = error.data;
        return errorResult(
          typeof data === "string" ? data : JSON.stringify(toJsonValue(data)),
        );
      }
      console.error(`MCP tool "${t.name}" failed`, error);
      return errorResult(`Tool "${t.name}" failed. Please try again later.`);
    }
    if (isObject(value) && (value as any)[RESULT]) {
      const { content, structuredContent, isError } = value as CallToolResult;
      return {
        content,
        ...(structuredContent ? { structuredContent } : {}),
        ...(isError ? { isError } : {}),
      };
    }
    return toCallToolResult(value, t.returns !== undefined);
  }

  // ---- OAuth endpoints ----------------------------------------------------

  private async handleRegister(ctx: ToolCtx, request: Request) {
    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return oauthError("invalid_client_metadata", "Body must be JSON", 400);
    }
    if (!isObject(body)) {
      return oauthError("invalid_client_metadata", "Body must be an object", 400);
    }
    const parsed = parseClientMetadata(body);
    if ("error" in parsed) {
      return oauthError(parsed.error, parsed.description, 400);
    }
    const clientId = randomToken("mcp_client_", 16);
    await ctx.runMutation(this.component.clients.upsert, {
      clientId,
      ...parsed.client,
    });
    return json(
      {
        client_id: clientId,
        client_id_issued_at: Math.floor(Date.now() / 1000),
        redirect_uris: parsed.client.redirectUris,
        grant_types: ["authorization_code", "refresh_token"],
        response_types: ["code"],
        token_endpoint_auth_method: "none",
        ...(parsed.client.clientName ? { client_name: parsed.client.clientName } : {}),
        ...(parsed.client.clientUri ? { client_uri: parsed.client.clientUri } : {}),
        ...(parsed.client.logoUri ? { logo_uri: parsed.client.logoUri } : {}),
      },
      201,
      { ...PUBLIC_CORS, "Cache-Control": "no-store" },
    );
  }

  /** Looks up a registered client, fetching its metadata document if needed. */
  private async resolveClient(ctx: ToolCtx, clientId: string) {
    if (isMetadataDocumentUrl(clientId)) {
      const fetched = await fetchClientMetadata(clientId);
      if (!fetched) return null;
      await ctx.runMutation(this.component.clients.upsert, {
        clientId,
        ...fetched,
      });
      return { clientId, ...fetched };
    }
    return await ctx.runQuery(this.component.clients.get, { clientId });
  }

  private async handleAuthorize(ctx: ToolCtx, request: Request) {
    const q = new URL(request.url).searchParams;
    const clientId = q.get("client_id");
    const redirectUri = q.get("redirect_uri");
    // Until client_id and redirect_uri are verified, never redirect.
    if (!clientId) return htmlError("Missing client_id");
    const client = await this.resolveClient(ctx, clientId);
    if (!client) return htmlError("Unknown client");
    let target = redirectUri;
    if (!target) {
      if (client.redirectUris.length !== 1) {
        return htmlError("Missing redirect_uri");
      }
      target = client.redirectUris[0];
    }
    if (!client.redirectUris.includes(target)) {
      return htmlError("redirect_uri is not registered for this client");
    }
    const state = q.get("state") ?? undefined;
    const fail = (error: string, description: string) =>
      redirect(
        withParams(target, {
          error,
          error_description: description,
          state,
          iss: this.issuer,
        }),
      );

    if (q.get("response_type") !== "code") {
      return fail("unsupported_response_type", "response_type must be code");
    }
    const codeChallenge = q.get("code_challenge");
    if (!codeChallenge || !/^[A-Za-z0-9_-]{43}$/.test(codeChallenge)) {
      return fail("invalid_request", "PKCE code_challenge is required");
    }
    if (q.get("code_challenge_method") !== "S256") {
      return fail("invalid_request", "code_challenge_method must be S256");
    }
    const resource = q.get("resource");
    if (resource && stripSlash(resource) !== this.resource) {
      return fail("invalid_target", `resource must be ${this.resource}`);
    }
    const scopes = this.parseScopes(q.get("scope"));
    if (!scopes) return fail("invalid_scope", "Unknown scope requested");

    const requestId = randomToken("mcp_req_", 16);
    await ctx.runMutation(this.component.oauth.createAuthRequest, {
      requestId,
      clientId: client.clientId,
      redirectUri: target,
      codeChallenge,
      state,
      scopes,
      resource: this.resource,
      ttlMs: AUTH_REQUEST_TTL_MS,
    });
    return redirect(withParams(this.options.consentUrl, { request: requestId }));
  }

  /** Requested scopes; all scopes when none are requested. */
  private parseScopes(scope: string | null): string[] | null {
    if (!scope?.trim()) return this.scopeNames;
    const requested = [...new Set(scope.trim().split(/\s+/))];
    // Ignore standard OIDC-ish scopes that some clients always send.
    const meaningful = requested.filter(
      (s) => !["openid", "profile", "email", "offline_access"].includes(s),
    );
    if (meaningful.some((s) => !this.scopeNames.includes(s))) return null;
    return meaningful.length ? meaningful : this.scopeNames;
  }

  private async handleToken(ctx: ToolCtx, request: Request) {
    const form = await readForm(request);
    if (!form) return oauthError("invalid_request", "Expected form body", 400);
    const grantType = form.get("grant_type");
    const clientId = form.get("client_id");
    if (!clientId) return oauthError("invalid_client", "client_id required", 401);
    const resource = form.get("resource");
    if (resource && stripSlash(resource) !== this.resource) {
      return oauthError("invalid_target", `resource must be ${this.resource}`, 400);
    }
    const ttls = {
      accessTtlMs: this.options.accessTokenTtlMs ?? DEFAULT_ACCESS_TTL_MS,
      refreshTtlMs: this.options.refreshTokenTtlMs ?? DEFAULT_REFRESH_TTL_MS,
    };
    const accessToken = randomToken(TOKEN_PREFIX.access);
    const refreshToken = randomToken(TOKEN_PREFIX.refresh);

    let result;
    if (grantType === "authorization_code") {
      const code = form.get("code");
      const verifier = form.get("code_verifier");
      const redirectUri = form.get("redirect_uri");
      if (!code || !redirectUri) {
        return oauthError("invalid_request", "code and redirect_uri required", 400);
      }
      if (!verifier || !/^[A-Za-z0-9._~-]{43,128}$/.test(verifier)) {
        return oauthError("invalid_request", "valid code_verifier required", 400);
      }
      result = await ctx.runMutation(this.component.oauth.exchangeCode, {
        codeHash: await sha256Hex(code),
        clientId,
        redirectUri,
        verifierChallenge: await sha256Base64Url(verifier),
        accessHash: await sha256Hex(accessToken),
        refreshHash: await sha256Hex(refreshToken),
        ...ttls,
      });
    } else if (grantType === "refresh_token") {
      const presented = form.get("refresh_token");
      if (!presented) {
        return oauthError("invalid_request", "refresh_token required", 400);
      }
      result = await ctx.runMutation(this.component.oauth.refresh, {
        refreshHash: await sha256Hex(presented),
        clientId,
        accessHash: await sha256Hex(accessToken),
        newRefreshHash: await sha256Hex(refreshToken),
        ...ttls,
      });
    } else {
      return oauthError("unsupported_grant_type", "Unsupported grant_type", 400);
    }
    if (!result.ok) return oauthError(result.error, undefined, 400);
    return json(
      {
        access_token: accessToken,
        token_type: "Bearer",
        expires_in: Math.floor(ttls.accessTtlMs / 1000),
        refresh_token: refreshToken,
        ...(result.scopes.length ? { scope: result.scopes.join(" ") } : {}),
      },
      200,
      { ...PUBLIC_CORS, "Cache-Control": "no-store", Pragma: "no-cache" },
    );
  }

  private async handleRevoke(ctx: ToolCtx, request: Request) {
    const form = await readForm(request);
    const token = form?.get("token");
    if (token) {
      await ctx.runMutation(this.component.oauth.revokeToken, {
        hash: await sha256Hex(token),
        clientId: form?.get("client_id") ?? undefined,
      });
    }
    // RFC 7009 §2.2: respond 200 even for unknown tokens.
    return new Response(null, { status: 200, headers: PUBLIC_CORS });
  }

  // ---- App API ------------------------------------------------------------

  /**
   * Functions for your app to export, powering the consent page and a
   * "Connected agents" settings page:
   *
   * ```ts
   * export const { getAuthRequest, authorize, listConnections,
   *   revokeConnection, createApiKey } = mcp.api({
   *   getUserId: async (ctx) =>
   *     (await ctx.auth.getUserIdentity())?.tokenIdentifier ?? null,
   * });
   * ```
   *
   * `getUserId` decides who a connection acts for; tools receive the same
   * value as `user.userId`. Use a stable ID that cannot collide across
   * identity providers (e.g. `tokenIdentifier`, or your users table ID).
   */
  api(opts: {
    getUserId: (ctx: { auth: Auth }) => Promise<string | null>;
  }) {
    const component = this.component;
    const requireUser = async (ctx: { auth: Auth }) => {
      const userId = await opts.getUserId(ctx);
      if (!userId) throw new ConvexError("Not signed in");
      return userId;
    };
    return {
      /** Details of a pending request, for the consent page. */
      getAuthRequest: queryGeneric({
        args: { requestId: v.string() },
        handler: async (ctx, args) => {
          const request = await ctx.runQuery(component.oauth.getAuthRequest, args);
          if (!request) return null;
          const scopes = this.options.scopes ?? {};
          return {
            serverName: this.options.title ?? this.options.name,
            clientId: request.clientId,
            clientName: request.clientName,
            clientUri: request.clientUri,
            logoUri: request.logoUri,
            redirectUri: request.redirectUri,
            status: request.status,
            scopes: request.scopes.map((name) => ({
              name,
              description: scopes[name] ?? name,
            })),
          };
        },
      }),
      /**
       * Approves or denies a request as the signed-in user. Returns the URL
       * to send the browser to (the agent's redirect URI).
       */
      authorize: actionGeneric({
        args: { requestId: v.string(), approve: v.boolean() },
        handler: async (ctx, args): Promise<{ redirectUrl: string }> => {
          const userId = await requireUser(ctx);
          const code = args.approve ? randomToken(TOKEN_PREFIX.code) : undefined;
          const decided = await ctx.runMutation(component.oauth.decideAuthRequest, {
            requestId: args.requestId,
            userId,
            approved: args.approve,
            codeHash: code ? await sha256Hex(code) : undefined,
            codeTtlMs: CODE_TTL_MS,
          });
          if (!decided) {
            throw new ConvexError("This request has expired. Start again from your agent.");
          }
          return {
            redirectUrl: withParams(decided.redirectUri, {
              ...(code
                ? { code }
                : { error: "access_denied", error_description: "The user denied access" }),
              state: decided.state,
              iss: this.issuer,
            }),
          };
        },
      }),
      /** The signed-in user's connected agents and API keys. */
      listConnections: queryGeneric({
        args: {},
        handler: async (ctx) => {
          const userId = await opts.getUserId(ctx);
          if (!userId) return [];
          const grants = await ctx.runQuery(component.grants.list, { userId });
          return grants.map((g) => ({
            id: g._id as string,
            kind: g.kind,
            name: g.name,
            clientId: g.clientId,
            scopes: g.scopes,
            createdAt: g._creationTime,
            lastUsedAt: g.lastUsedAt,
          }));
        },
      }),
      revokeConnection: mutationGeneric({
        args: { id: v.string() },
        handler: async (ctx, args) => {
          const userId = await requireUser(ctx);
          return await ctx.runMutation(component.grants.revoke, {
            userId,
            grantId: args.id,
          });
        },
      }),
      /**
       * Creates a personal API key. The key is returned once; only its hash
       * is stored. Use it as `Authorization: Bearer <key>`.
       */
      createApiKey: actionGeneric({
        args: { name: v.string(), scopes: v.optional(v.array(v.string())) },
        handler: async (ctx, args): Promise<{ id: string; apiKey: string; url: string }> => {
          const userId = await requireUser(ctx);
          const name = args.name.trim().slice(0, 100) || "API key";
          const scopes = args.scopes ?? this.scopeNames;
          if (scopes.some((s) => !this.scopeNames.includes(s))) {
            throw new ConvexError("Unknown scope");
          }
          const apiKey = randomToken(TOKEN_PREFIX.apiKey);
          const id = await ctx.runMutation(component.grants.createApiKey, {
            userId,
            name,
            scopes,
            resource: this.resource,
            hash: await sha256Hex(apiKey),
          });
          return { id, apiKey, url: this.resource };
        },
      }),
    };
  }
}

// ---------------------------------------------------------------------------
// Helpers

function toCallToolResult(value: unknown, structured: boolean): CallToolResult {
  if (value === undefined || value === null) {
    return { content: [{ type: "text", text: value === null ? "null" : "Done" }] };
  }
  if (typeof value === "string") {
    return { content: [{ type: "text", text: value }] };
  }
  const jsonValue = toJsonValue(value);
  const result: CallToolResult = {
    content: [{ type: "text", text: JSON.stringify(jsonValue, null, 2) }],
  };
  if (structured && isObject(jsonValue)) {
    result.structuredContent = jsonValue;
  }
  return result;
}

function errorResult(text: string): CallToolResult {
  return { content: [{ type: "text", text }], isError: true };
}

function rpcResult(id: string | number, result: unknown) {
  return { jsonrpc: "2.0", id, result };
}

function rpcError(id: string | number | null, code: number, message: string) {
  return { jsonrpc: "2.0", id, error: { code, message } };
}

const PUBLIC_CORS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Authorization, Content-Type, MCP-Protocol-Version",
};

async function preflight() {
  return new Response(null, { status: 204, headers: PUBLIC_CORS });
}

function json(body: unknown, status: number, headers: Record<string, string> = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...headers },
  });
}

function oauthError(error: string, description: string | undefined, status: number) {
  return json(
    { error, ...(description ? { error_description: description } : {}) },
    status,
    { ...PUBLIC_CORS, "Cache-Control": "no-store" },
  );
}

function redirect(location: string) {
  return new Response(null, {
    status: 302,
    headers: { Location: location, "Cache-Control": "no-store" },
  });
}

function htmlError(message: string) {
  const escaped = message.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
  return new Response(
    `<!doctype html><meta charset="utf-8"><title>Authorization error</title><p>${escaped}</p>`,
    { status: 400, headers: { "Content-Type": "text/html; charset=utf-8" } },
  );
}

function withParams(base: string, params: Record<string, string | undefined>) {
  const url = new URL(base);
  for (const [k, value] of Object.entries(params)) {
    if (value !== undefined) url.searchParams.set(k, value);
  }
  return url.toString();
}

async function readForm(request: Request): Promise<URLSearchParams | null> {
  const type = request.headers.get("Content-Type") ?? "";
  try {
    if (type.includes("application/json")) {
      const body = await request.json();
      if (!isObject(body)) return null;
      const form = new URLSearchParams();
      for (const [k, value] of Object.entries(body)) {
        if (typeof value === "string") form.set(k, value);
      }
      return form;
    }
    return new URLSearchParams(await request.text());
  } catch {
    return null;
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizePath(path: string) {
  const p = "/" + path.replace(/^\/+|\/+$/g, "");
  if (p === "/") throw new Error("McpServer `path` cannot be the root");
  return p;
}

function stripSlash(url: string) {
  return url.replace(/\/+$/, "");
}

const MAX_REDIRECT_URIS = 10;
const MAX_URL_LENGTH = 2000;
const MAX_NAME_LENGTH = 200;

/** Validates RFC 7591 client metadata (also used for metadata documents). */
export function parseClientMetadata(body: Record<string, unknown>):
  | {
      client: {
        redirectUris: string[];
        clientName?: string;
        clientUri?: string;
        logoUri?: string;
      };
    }
  | { error: string; description: string } {
  const uris = body.redirect_uris;
  if (
    !Array.isArray(uris) ||
    uris.length === 0 ||
    uris.length > MAX_REDIRECT_URIS ||
    !uris.every((u) => typeof u === "string" && isAllowedRedirect(u))
  ) {
    return {
      error: "invalid_redirect_uri",
      description:
        "redirect_uris must be 1-10 https, loopback http, or app-scheme URLs",
    };
  }
  const method = body.token_endpoint_auth_method;
  if (method !== undefined && method !== "none") {
    return {
      error: "invalid_client_metadata",
      description: "Only public clients (token_endpoint_auth_method=none) are supported",
    };
  }
  const str = (value: unknown, max: number) =>
    typeof value === "string" && value.length > 0 ? value.slice(0, max) : undefined;
  const httpsUrl = (value: unknown) => {
    const s = str(value, MAX_URL_LENGTH);
    return s && /^https:\/\//.test(s) ? s : undefined;
  };
  return {
    client: {
      redirectUris: uris as string[],
      clientName: str(body.client_name, MAX_NAME_LENGTH),
      clientUri: httpsUrl(body.client_uri),
      logoUri: httpsUrl(body.logo_uri),
    },
  };
}

function isAllowedRedirect(uri: string) {
  if (uri.length > MAX_URL_LENGTH) return false;
  let url: URL;
  try {
    url = new URL(uri);
  } catch {
    return false;
  }
  if (url.hash) return false;
  if (url.protocol === "https:") return true;
  if (url.protocol === "http:") {
    return ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  }
  // Native apps use private-use schemes (e.g. cursor://).
  return !["javascript:", "data:", "file:", "vbscript:", "blob:"].includes(url.protocol);
}

function isMetadataDocumentUrl(clientId: string) {
  try {
    const url = new URL(clientId);
    return url.protocol === "https:" && url.pathname !== "/" && !url.hash;
  } catch {
    return false;
  }
}

/** Fetches a client ID metadata document (MCP 2025-11-25). */
async function fetchClientMetadata(clientId: string) {
  const host = new URL(clientId).hostname;
  if (
    host === "localhost" ||
    /^[0-9.]+$/.test(host) ||
    host.startsWith("[")
  ) {
    return null;
  }
  try {
    const response = await fetch(clientId, {
      headers: { Accept: "application/json" },
      redirect: "error",
      signal: AbortSignal.timeout(5000),
    });
    if (!response.ok) return null;
    const text = await response.text();
    if (text.length > 10_000) return null;
    const body = JSON.parse(text);
    if (!isObject(body) || body.client_id !== clientId) return null;
    const parsed = parseClientMetadata(body);
    return "error" in parsed ? null : parsed.client;
  } catch {
    return null;
  }
}

export type { JSONSchema };
