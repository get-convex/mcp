import {
  actionGeneric,
  httpActionGeneric,
  internalActionGeneric,
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
  VString,
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
export type McpUser<UserId extends string = string> = {
  userId: UserId;
  /**
   * Scopes this connection was granted. They can only narrow what the user
   * can do: pass the whole `McpUser` to your authorization code so it can
   * treat e.g. a read-only connection as a viewer.
   */
  scopes: string[];
  /** The OAuth client ID, or undefined for personal API keys. */
  clientId?: string;
  connectionId: string;
};

/**
 * Validator for passing an `McpUser` into your internal functions, so your
 * authorization code sees the connection's scopes, not just the user ID:
 *
 * ```ts
 * export const addForUser = internalMutation({
 *   args: { user: vMcpUser(v.id("users")), text: v.string() },
 *   handler: async (ctx, { user, text }) => { ... },
 * });
 * ```
 */
export function vMcpUser<UserId extends GenericValidator = VString<string>>(
  userId?: UserId,
) {
  return v.object({
    userId: (userId ?? v.string()) as UserId,
    scopes: v.array(v.string()),
    clientId: v.optional(v.string()),
    connectionId: v.string(),
  });
}

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
  UserId extends string = string,
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
    user: McpUser<UserId>,
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

/**
 * Returns a `tool` helper whose handlers see `user.userId` typed as your user
 * ID type, so no casts are needed:
 *
 * ```ts
 * const tool = createTool<Id<"users">>();
 * ```
 */
export function createTool<UserId extends string>() {
  return <
    Args extends PropertyValidators = Record<string, never>,
    Returns extends GenericValidator | undefined = undefined,
  >(
    definition: ToolDefinition<Args, Returns, UserId>,
  ): ToolDefinition<any, any, UserId> =>
    definition as ToolDefinition<any, any, UserId>;
}

// ---------------------------------------------------------------------------
// Server

export type McpServerOptions<UserId extends string = string> = {
  /** Server name reported to clients in `serverInfo`. */
  name: string;
  version: string;
  title?: string;
  /** Guidance for the model on how to use this server's tools. */
  instructions?: string;
  tools: Record<string, ToolDefinition<any, any, UserId>>;
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
  /**
   * Accept OAuth clients identified by a client ID metadata document URL
   * (MCP 2025-11-25) from these hosts, e.g. `["claude.ai"]`. Off by default:
   * fetching arbitrary URLs from your backend is an SSRF risk. Dynamic client
   * registration works for all clients either way.
   */
  clientMetadataDocumentHosts?: string[];
  /**
   * Let agents that can only make HTTP requests sign in with the device flow
   * (RFC 8628): they get a link for the user to approve, then a short-lived
   * access token (no refresh token). Default true.
   */
  deviceFlow?: boolean;
  /**
   * List tool names and descriptions on the public `GET /mcp` guide. Off by
   * default: `tools/list` (which respects each connection's scopes) only
   * works after sign-in.
   */
  describeTools?: boolean;
  accessTokenTtlMs?: number;
  refreshTokenTtlMs?: number;
  /**
   * Log `lint()` findings (risky tool setups) once per process on the first
   * MCP request. Default true.
   */
  warnings?: boolean;
};

/**
 * "Modern" versions are stateless: every request carries its version and
 * capabilities in `_meta`, with no `initialize` handshake.
 */
export const MODERN_PROTOCOL_VERSIONS = ["2026-07-28"];
/** "Legacy" versions start with an `initialize` handshake. */
export const LEGACY_PROTOCOL_VERSIONS = ["2025-11-25", "2025-06-18", "2025-03-26"];
export const PROTOCOL_VERSIONS = [
  ...MODERN_PROTOCOL_VERSIONS,
  ...LEGACY_PROTOCOL_VERSIONS,
];
const LATEST_LEGACY_VERSION = LEGACY_PROTOCOL_VERSIONS[0];

const META = "io.modelcontextprotocol/";
// JSON-RPC error codes defined by MCP 2026-07-28.
const HEADER_MISMATCH = -32020;
const UNSUPPORTED_PROTOCOL_VERSION = -32022;
const TOOLS_LIST_TTL_MS = 5 * 60_000;

const AUTH_REQUEST_TTL_MS = 10 * 60_000;
const CODE_TTL_MS = 60_000;
/** Pre-registered public client for agents using the device flow. */
export const DEVICE_CLIENT_ID = "mcp-agent";
const DEVICE_GRANT = "urn:ietf:params:oauth:grant-type:device_code";
const DEVICE_TTL_MS = 10 * 60_000;
const DEVICE_INTERVAL_MS = 5_000;
// No vowels or look-alikes: avoids words and misreads.
const USER_CODE_ALPHABET = "BCDFGHJKLMNPQRSTVWXZ";
const DEFAULT_ACCESS_TTL_MS = 60 * 60_000;
const DEFAULT_REFRESH_TTL_MS = 30 * 24 * 60 * 60_000;

type CompiledTool = {
  name: string;
  definition: ToolDefinition<any, any, any>;
  args: GenericValidator;
  returns?: GenericValidator;
  listing: Record<string, unknown>;
};

export class McpServer<UserId extends string = string> {
  private readonly tools: Map<string, CompiledTool>;
  readonly path: string;
  private warned = false;

  constructor(
    public component: ComponentApi,
    public options: McpServerOptions<UserId>,
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
    route(p, "GET", async (_ctx, req) => this.mcpCors(req, this.handleGet(req)));
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
    if (this.deviceFlow) {
      route(`${p}/oauth/device`, "POST", (ctx, req) => this.handleDevice(ctx, req));
      route(`${p}/oauth/device`, "OPTIONS", preflight);
    }
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
      grant_types_supported: [
        "authorization_code",
        "refresh_token",
        ...(this.deviceFlow ? [DEVICE_GRANT] : []),
      ],
      ...(this.deviceFlow
        ? { device_authorization_endpoint: `${base}/device` }
        : {}),
      token_endpoint_auth_methods_supported: ["none"],
      revocation_endpoint_auth_methods_supported: ["none"],
      code_challenge_methods_supported: ["S256"],
      ...(this.options.clientMetadataDocumentHosts?.length
        ? { client_id_metadata_document_supported: true }
        : {}),
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
  async authenticate(
    ctx: ToolCtx,
    request: Request,
  ): Promise<McpUser<UserId> | null> {
    const header = request.headers.get("Authorization");
    const match = header?.match(/^Bearer\s+(\S+)$/i);
    if (!match) return null;
    const info = await ctx.runQuery(this.component.tokens.verify, {
      hash: await sha256Hex(match[1]),
      now: Date.now(),
    });
    // Tokens are audience-bound to this server (RFC 8707).
    if (!info || info.resource !== this.resource) return null;
    if (info.stale) {
      await ctx.runMutation(this.component.tokens.touch, {
        grantId: info.grantId,
      });
    }
    return {
      userId: info.userId as UserId,
      scopes: info.scopes,
      clientId: info.clientId,
      connectionId: info.grantId,
    };
  }

  /**
   * Risky setups worth fixing: write tools without a scope, tools without
   * annotations, no scopes at all. Assert `expect(mcp.lint()).toEqual([])`
   * in a test to keep it that way.
   */
  lint(): string[] {
    const findings: string[] = [];
    const scopes = this.scopeNames;
    if (scopes.length === 0) {
      findings.push(
        "No `scopes`: users can't connect a read-only agent. Add e.g. `<area>:read` and `<area>:write`.",
      );
    }
    for (const t of this.tools.values()) {
      const d = t.definition;
      if (!d.annotations) {
        findings.push(
          `Tool "${t.name}" has no annotations; clients assume it is destructive and open-world. Set readOnlyHint/destructiveHint/openWorldHint.`,
        );
      }
      if (scopes.length && !d.scope) {
        findings.push(
          `Tool "${t.name}" has no \`scope\`, so every connection (even read-only ones) can call it.`,
        );
      }
      if (d.annotations?.readOnlyHint === true && d.scope && /write|admin|manage/i.test(d.scope)) {
        findings.push(
          `Tool "${t.name}" is read-only but requires the write-like scope "${d.scope}"; read-only connections can't use it.`,
        );
      }
    }
    return findings;
  }

  async handleMcp(ctx: ToolCtx, request: Request): Promise<Response> {
    if (!this.warned && this.options.warnings !== false) {
      this.warned = true;
      for (const finding of this.lint()) console.warn(`[@convex-dev/mcp] ${finding}`);
    }
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

    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return respond(json(rpcError(null, -32700, "Parse error"), 400));
    }

    // Requests carrying `_meta` protocol fields (or a modern version header)
    // use the stateless 2026-07-28 protocol; everything else is served with
    // legacy (initialize-based) semantics.
    const headerVersion = request.headers.get("MCP-Protocol-Version");
    const metaVersion = isObject(body)
      ? metaOf(body)?.[`${META}protocolVersion`]
      : undefined;
    if (
      metaVersion !== undefined ||
      (headerVersion && MODERN_PROTOCOL_VERSIONS.includes(headerVersion))
    ) {
      return respond(await this.handleModern(ctx, request, body, user));
    }
    // Absent header means 2025-03-26 (Streamable HTTP §Protocol Version Header).
    if (headerVersion && !PROTOCOL_VERSIONS.includes(headerVersion)) {
      return respond(unsupportedVersion(null, headerVersion));
    }
    return respond(await this.handleLegacy(ctx, body, headerVersion, user));
  }

  /** MCP 2026-07-28: one stateless request per POST. */
  private async handleModern(
    ctx: ToolCtx,
    request: Request,
    body: unknown,
    user: McpUser<UserId>,
  ): Promise<Response> {
    if (!isObject(body) || body.jsonrpc !== "2.0" || typeof body.method !== "string") {
      return json(rpcError(null, -32600, "Invalid Request"), 400);
    }
    const method = body.method;
    const id = body.id as string | number | null | undefined;
    if (id === undefined) {
      // No client notifications are defined over HTTP; accept and ignore.
      return new Response(null, { status: 202 });
    }
    if (typeof id !== "string" && typeof id !== "number") {
      return json(rpcError(null, -32600, "Invalid Request"), 400);
    }
    const params = isObject(body.params) ? body.params : {};
    const meta = metaOf(body) ?? {};
    const version = meta[`${META}protocolVersion`];
    if (typeof version !== "string" || !isObject(meta[`${META}clientCapabilities`])) {
      return json(
        rpcError(id, -32602, `Missing _meta["${META}protocolVersion"] or _meta["${META}clientCapabilities"]`),
        400,
      );
    }
    if (!MODERN_PROTOCOL_VERSIONS.includes(version)) {
      return unsupportedVersion(id, version);
    }

    // Headers mirror the body so intermediaries can route on them; they must
    // agree (Streamable HTTP §Server Validation).
    const mismatch = (message: string) =>
      json(rpcError(id, HEADER_MISMATCH, `Header mismatch: ${message}`), 400);
    const headerVersion = request.headers.get("MCP-Protocol-Version");
    if (headerVersion !== version) {
      return mismatch(`MCP-Protocol-Version is ${headerVersion ?? "missing"}, body says ${version}`);
    }
    const headerMethod = request.headers.get("Mcp-Method");
    if (headerMethod !== method) {
      return mismatch(`Mcp-Method is ${headerMethod ?? "missing"}, body says ${method}`);
    }
    if (["tools/call", "resources/read", "prompts/get"].includes(method)) {
      const bodyName = method === "resources/read" ? params.uri : params.name;
      const headerName = decodeHeaderValue(request.headers.get("Mcp-Name"));
      if (headerName === null || headerName !== bodyName) {
        return mismatch("Mcp-Name does not match the request body");
      }
    }

    const result = (value: Record<string, unknown>) =>
      json(
        rpcResult(id, {
          resultType: "complete",
          ...value,
          _meta: { [`${META}serverInfo`]: this.serverInfo },
        }),
        200,
      );
    switch (method) {
      case "server/discover":
        return result({
          supportedVersions: PROTOCOL_VERSIONS,
          capabilities: this.capabilities,
          ...(this.options.instructions
            ? { instructions: this.options.instructions }
            : {}),
          ttlMs: TOOLS_LIST_TTL_MS,
          cacheScope: "public",
        });
      case "tools/list":
        return result({
          tools: this.listTools(user),
          ttlMs: TOOLS_LIST_TTL_MS,
          // The list depends on the caller's scopes.
          cacheScope: "private",
        });
      case "tools/call": {
        const t = this.toolFor(params.name);
        if (!t) {
          return json(rpcError(id, -32602, `Unknown tool: ${String(params.name)}`), 200);
        }
        if (!this.allowed(t, user)) return this.insufficientScope(t.definition.scope!);
        return result(await this.callTool(ctx, t, params.arguments ?? {}, user));
      }
      default:
        return json(rpcError(id, -32601, `Method not found: ${method}`), 404);
    }
  }

  /** MCP 2025-03-26 through 2025-11-25 (initialize-based, stateless here). */
  private async handleLegacy(
    ctx: ToolCtx,
    body: unknown,
    headerVersion: string | null,
    user: McpUser<UserId>,
  ): Promise<Response> {
    const batch = Array.isArray(body);
    if (batch && headerVersion && headerVersion !== "2025-03-26") {
      return json(rpcError(null, -32600, "JSON-RPC batching is not supported"), 400);
    }
    const messages = batch ? (body as unknown[]) : [body];
    if (messages.length === 0) {
      return json(rpcError(null, -32600, "Invalid Request"), 400);
    }
    const responses: unknown[] = [];
    for (const message of messages) {
      const result = await this.handleLegacyMessage(ctx, message, user);
      if (result instanceof Response) return result;
      if (result !== undefined) responses.push(result);
    }
    if (responses.length === 0) {
      // Only notifications or responses: 202 with no body.
      return new Response(null, { status: 202 });
    }
    return json(batch ? responses : responses[0], 200);
  }

  private async handleLegacyMessage(
    ctx: ToolCtx,
    message: unknown,
    user: McpUser<UserId>,
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
          typeof requested === "string" && LEGACY_PROTOCOL_VERSIONS.includes(requested)
            ? requested
            : LATEST_LEGACY_VERSION;
        return rpcResult(id, {
          protocolVersion,
          capabilities: this.capabilities,
          serverInfo: this.serverInfo,
          ...(this.options.instructions
            ? { instructions: this.options.instructions }
            : {}),
        });
      }
      case "ping":
        return rpcResult(id, {});
      case "tools/list":
        return rpcResult(id, { tools: this.listTools(user) });
      case "tools/call": {
        const t = this.toolFor(p.name);
        if (!t) return rpcError(id, -32602, `Unknown tool: ${String(p.name)}`);
        if (!this.allowed(t, user)) {
          return this.insufficientScope(t.definition.scope!);
        }
        return rpcResult(id, await this.callTool(ctx, t, p.arguments ?? {}, user));
      }
      default:
        return rpcError(id, -32601, `Method not found: ${method}`);
    }
  }

  private get serverInfo() {
    return {
      name: this.options.name,
      version: this.options.version,
      ...(this.options.title ? { title: this.options.title } : {}),
    };
  }

  private get capabilities() {
    return { tools: { listChanged: false } };
  }

  /** Tools visible to this connection, in definition order (deterministic). */
  private listTools(user: McpUser<UserId>) {
    return [...this.tools.values()]
      .filter((t) => this.allowed(t, user))
      .map((t) => t.listing);
  }

  private toolFor(name: unknown) {
    return typeof name === "string" ? this.tools.get(name) : undefined;
  }

  private allowed(t: CompiledTool, user: McpUser<UserId>) {
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
    user: McpUser<UserId>,
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
      // structuredContent must still match `returns`. Content blocks are the
      // developer's responsibility.
      if (t.returns && !isError) {
        const checked = checkValue(t.returns, structuredContent, "result");
        if (!checked.ok) {
          console.error(`MCP tool "${t.name}" returned invalid structuredContent: ${checked.error}`);
          return errorResult(`Tool "${t.name}" failed. Please try again later.`);
        }
      }
      return {
        content,
        ...(structuredContent ? { structuredContent } : {}),
        ...(isError ? { isError } : {}),
      };
    }
    if (t.returns) {
      // Enforce `returns` so results match the advertised outputSchema and
      // can't carry fields the developer didn't intend to expose.
      const checked = checkValue(t.returns, toJsonValue(value), "result");
      if (!checked.ok) {
        console.error(`MCP tool "${t.name}" returned an invalid result: ${checked.error}`);
        return errorResult(`Tool "${t.name}" failed. Please try again later.`);
      }
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
    const registered = await ctx.runMutation(this.component.clients.register, {
      clientId,
      ...parsed.client,
    });
    if (!registered.ok) return tooManyRequests(registered.retryAfterMs);
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
      const host = new URL(clientId).hostname;
      if (!this.options.clientMetadataDocumentHosts?.includes(host)) return null;
      const fetched = await fetchClientMetadata(clientId);
      if (!fetched) return null;
      await ctx.runMutation(this.component.clients.upsertMetadataDocument, {
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
    const created = await ctx.runMutation(this.component.oauth.createAuthRequest, {
      requestId,
      clientId: client.clientId,
      redirectUri: target,
      codeChallenge,
      state,
      scopes,
      resource: this.resource,
      ttlMs: AUTH_REQUEST_TTL_MS,
    });
    if (!created.ok) {
      return fail("temporarily_unavailable", "Too many requests, try again shortly");
    }
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
    } else if (grantType === DEVICE_GRANT && this.deviceFlow) {
      const deviceCode = form.get("device_code");
      if (!deviceCode) {
        return oauthError("invalid_request", "device_code required", 400);
      }
      const polled = await ctx.runMutation(this.component.oauth.pollDevice, {
        deviceCodeHash: await sha256Hex(deviceCode),
        clientId,
        accessHash: await sha256Hex(accessToken),
        accessTtlMs: ttls.accessTtlMs,
      });
      if (!polled.ok) return oauthError(polled.error, undefined, 400);
      // No refresh token: device-flow tokens may live in chat transcripts.
      return json(
        {
          access_token: accessToken,
          token_type: "Bearer",
          expires_in: Math.floor(ttls.accessTtlMs / 1000),
          ...(polled.scopes.length ? { scope: polled.scopes.join(" ") } : {}),
        },
        200,
        { ...PUBLIC_CORS, "Cache-Control": "no-store", Pragma: "no-cache" },
      );
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

  private get deviceFlow() {
    return this.options.deviceFlow !== false;
  }

  /** RFC 8628 §3.1–3.2 device authorization request. */
  private async handleDevice(ctx: ToolCtx, request: Request) {
    const form = await readForm(request);
    if (!form) return oauthError("invalid_request", "Expected form body", 400);
    const clientId = form.get("client_id");
    if (!clientId) {
      return oauthError(
        "invalid_client",
        `client_id required (agents can use the public client "${DEVICE_CLIENT_ID}")`,
        401,
      );
    }
    let clientName: string | undefined;
    if (clientId === DEVICE_CLIENT_ID) {
      clientName = sanitizeName(form.get("client_name")) ?? "An agent";
    } else if (!(await this.resolveClient(ctx, clientId))) {
      return oauthError("invalid_client", "Unknown client", 401);
    }
    const resource = form.get("resource");
    if (resource && stripSlash(resource) !== this.resource) {
      return oauthError("invalid_target", `resource must be ${this.resource}`, 400);
    }
    const scopes = this.parseScopes(form.get("scope"));
    if (!scopes) return oauthError("invalid_scope", "Unknown scope requested", 400);

    const deviceCode = randomToken("mcp_dc_");
    const requestId = randomToken("mcp_req_", 16);
    let userCode = "";
    for (let attempt = 0; ; attempt++) {
      userCode = generateUserCode();
      try {
        const created = await ctx.runMutation(this.component.oauth.createDeviceRequest, {
          requestId,
          clientId,
          clientName,
          deviceCodeHash: await sha256Hex(deviceCode),
          userCode,
          scopes,
          resource: this.resource,
          ttlMs: DEVICE_TTL_MS,
          intervalMs: DEVICE_INTERVAL_MS,
        });
        if (!created.ok) return tooManyRequests(created.retryAfterMs);
        break;
      } catch (error) {
        if (attempt >= 2) throw error; // user code collisions are vanishingly rare
      }
    }
    return json(
      {
        device_code: deviceCode,
        user_code: userCode,
        verification_uri: this.options.consentUrl,
        verification_uri_complete: withParams(this.options.consentUrl, { request: requestId }),
        expires_in: DEVICE_TTL_MS / 1000,
        interval: DEVICE_INTERVAL_MS / 1000,
      },
      200,
      { ...PUBLIC_CORS, "Cache-Control": "no-store" },
    );
  }

  /**
   * `GET /mcp`. MCP clients only POST (legacy ones may GET for a server-sent
   * event stream, which we don't offer: 405). Everyone else — a browser, or
   * an agent that fetched the URL — gets a guide to connecting.
   */
  private handleGet(request: Request): Response {
    const accept = request.headers.get("Accept") ?? "";
    if (accept.includes("text/event-stream")) {
      return new Response(null, { status: 405, headers: { Allow: "POST" } });
    }
    const markdown = accept.includes("text/markdown");
    return new Response(this.guide(), {
      status: 200,
      headers: {
        "Content-Type": `${markdown ? "text/markdown" : "text/plain"}; charset=utf-8`,
        Vary: "Accept",
        "Cache-Control": "public, max-age=300",
      },
    });
  }

  /** Agent-readable instructions for using this server. */
  guide(): string {
    const name = this.options.title ?? this.options.name;
    const base = this.oauthBase;
    const url = this.resource;
    const scopes = Object.entries(this.options.scopes ?? {});
    const lines: string[] = [
      `# ${name} — MCP server`,
      "",
      ...(this.options.instructions ? [this.options.instructions, ""] : []),
      `This is a Model Context Protocol (MCP) server: ${url}`,
      "",
      "## Connect an MCP client",
      "",
      "Add the URL above as a remote (Streamable HTTP) MCP server. Sign-in is OAuth and happens in the browser. For example:",
      "",
      `    claude mcp add --transport http ${this.options.name} ${url}`,
      "",
      "In claude.ai or ChatGPT: Settings → Connectors → add a custom connector with this URL.",
    ];
    if (this.deviceFlow) {
      lines.push(
        "",
        "## Agents with only an HTTP tool: use it directly",
        "",
        "You can call this server with plain HTTP requests. The user must approve you first.",
        "",
        "### 1. Request access",
        "",
        `    curl -s -X POST ${base}/device -d client_id=${DEVICE_CLIENT_ID} -d "client_name=<your name>"` +
          (scopes.length ? ` -d "scope=${scopes.map(([s]) => s).join(" ")}"` : ""),
        "",
        "`client_name` is shown to the user on the approval screen: use your product's name (e.g. Claude).",
        "",
        "The JSON response has `verification_uri_complete`, `user_code`, `device_code`, `interval` and `expires_in`.",
        "",
        "### 2. Ask the user to approve",
        "",
        `Show the user \`verification_uri_complete\` as a clickable link, and the \`user_code\`. Say something like: "Open this link to let me use ${name}. Check that it shows the code ABCD-EFGH." Repeating the \`user_code\` is fine; never share the \`device_code\`.`,
        "",
        `The link opens ${name}'s own website, which may be on a different host than this API. That's expected.`,
        "",
        "### 3. Get a token",
        "",
        "Poll every `interval` seconds until approved:",
        "",
        `    curl -s -X POST ${base}/token -d grant_type=${DEVICE_GRANT} -d client_id=${DEVICE_CLIENT_ID} -d device_code=<device_code>`,
        "",
        "- `authorization_pending`: the user hasn't approved yet; keep polling.",
        "- `slow_down`: add 5 seconds to your interval.",
        "- `access_denied` or `expired_token`: stop; start again if the user wants. The request expires after `expires_in` seconds (about 10 minutes).",
        "- Success: `access_token`, valid for `expires_in` seconds. There is no refresh token; request access again when it expires. Keep the token out of messages to the user.",
        "",
        "### 4. Call tools",
        "",
        "Every request is a JSON-RPC POST. The headers and `_meta` shown are required (MCP 2026-07-28). Start with `tools/list` to see the tools, their descriptions and argument schemas:",
        "",
        `    curl -s ${url} \\`,
        `      -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \\`,
        `      -H "MCP-Protocol-Version: 2026-07-28" -H "Mcp-Method: tools/list" \\`,
        `      -d '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{"_meta":{"io.modelcontextprotocol/protocolVersion":"2026-07-28","io.modelcontextprotocol/clientCapabilities":{}}}}'`,
        "",
        "Then call a tool (`Mcp-Name` must equal `params.name`):",
        "",
        `    curl -s ${url} \\`,
        `      -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \\`,
        `      -H "MCP-Protocol-Version: 2026-07-28" -H "Mcp-Method: tools/call" -H "Mcp-Name: <tool>" \\`,
        `      -d '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"<tool>","arguments":{},"_meta":{"io.modelcontextprotocol/protocolVersion":"2026-07-28","io.modelcontextprotocol/clientCapabilities":{}}}}'`,
        "",
        "Results are in `result.structuredContent` (and as text in `result.content`). `result.isError: true` means the call failed with a message you can act on. HTTP 401 means the token expired: request access again.",
      );
    }
    if (scopes.length) {
      lines.push("", "## Scopes", "", ...scopes.map(([s, d]) => `- \`${s}\`: ${d}`));
    }
    if (this.options.describeTools) {
      lines.push(
        "",
        "## Tools",
        "",
        ...[...this.tools.values()].map(
          (t) => `- \`${t.name}\`: ${t.definition.description.replace(/\s+/g, " ")}`,
        ),
      );
    }
    return lines.join("\n") + "\n";
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
    getUserId: (ctx: { auth: Auth }) => Promise<UserId | null>;
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
            /**
             * "device": an agent started this and is waiting; show `userCode`
             * and require the user to confirm it matches what the agent
             * shows. "redirect": the user is sent back to `redirectUri`.
             */
            kind: request.kind,
            clientId: request.clientId,
            /** Self-reported by the client: label it as unverified. */
            clientName: request.clientName,
            clientUri: request.kind === "redirect" ? request.clientUri : undefined,
            logoUri: request.kind === "redirect" ? request.logoUri : undefined,
            redirectUri: request.kind === "redirect" ? request.redirectUri : undefined,
            userCode: request.kind === "device" ? request.userCode : undefined,
            status: request.status,
            scopes: request.scopes.map((name) => ({
              name,
              description: scopes[name] ?? name,
            })),
          };
        },
      }),
      /**
       * Finds a device request by the code the user typed (for a consent
       * page opened without `?request=`). Rate limited per user.
       */
      findAuthRequest: mutationGeneric({
        args: { userCode: v.string() },
        handler: async (ctx, args): Promise<string | null> => {
          const userId = await requireUser(ctx);
          const userCode = normalizeUserCode(args.userCode);
          if (!userCode) return null;
          const found = await ctx.runMutation(component.oauth.findByUserCode, {
            userCode,
            limitKey: userId,
          });
          if (!found.ok) throw new ConvexError("Too many attempts. Try again in a few minutes.");
          return found.requestId;
        },
      }),
      /**
       * Approves or denies a request as the signed-in user. For redirect
       * requests, returns the URL to send the browser to (back to the
       * agent). For device requests, `redirectUrl` is null: tell the user to
       * return to their agent.
       */
      authorize: actionGeneric({
        args: { requestId: v.string(), approve: v.boolean() },
        handler: async (ctx, args): Promise<{ redirectUrl: string | null }> => {
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
          if (decided.kind === "device") return { redirectUrl: null };
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
        handler: async (ctx, args): Promise<{ id: string; apiKey: string; url: string }> =>
          this.mintApiKey(ctx, await requireUser(ctx), args),
      }),
    };
  }

  /**
   * Internal functions for operators and testing. They take a `userId`
   * directly, so they are `internalAction`s: only callable from your own
   * backend code or with deploy credentials (`npx convex run`, dashboard).
   *
   * ```ts
   * export const { createApiKeyForUser } = mcp.internalApi();
   * ```
   * ```sh
   * npx convex run mcp:createApiKeyForUser '{"userId":"<id getUserId returns>"}'
   * ```
   */
  internalApi() {
    return {
      createApiKeyForUser: internalActionGeneric({
        args: {
          userId: v.string(),
          name: v.optional(v.string()),
          scopes: v.optional(v.array(v.string())),
        },
        handler: async (ctx, args): Promise<{ id: string; apiKey: string; url: string }> =>
          this.mintApiKey(ctx, args.userId, {
            name: args.name ?? "CLI key",
            scopes: args.scopes,
          }),
      }),
    };
  }

  private async mintApiKey(
    ctx: { runMutation: ToolCtx["runMutation"] },
    userId: string,
    args: { name: string; scopes?: string[] },
  ) {
    const name = args.name.trim().slice(0, 100) || "API key";
    const scopes = args.scopes ?? this.scopeNames;
    if (scopes.some((s) => !this.scopeNames.includes(s))) {
      throw new ConvexError("Unknown scope");
    }
    const apiKey = randomToken(TOKEN_PREFIX.apiKey);
    const id = await ctx.runMutation(this.component.grants.createApiKey, {
      userId,
      name,
      scopes,
      resource: this.resource,
      hash: await sha256Hex(apiKey),
    });
    return { id, apiKey, url: this.resource };
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

function metaOf(message: Record<string, unknown>) {
  const params = message.params;
  if (!isObject(params) || !isObject(params._meta)) return undefined;
  return params._meta;
}

function unsupportedVersion(id: string | number | null, requested: string) {
  return json(
    {
      jsonrpc: "2.0",
      id,
      error: {
        code: UNSUPPORTED_PROTOCOL_VERSION,
        message: "Unsupported protocol version",
        data: { supported: PROTOCOL_VERSIONS, requested },
      },
    },
    400,
  );
}

/** Decodes the `=?base64?…?=` sentinel used for non-ASCII header values. */
function decodeHeaderValue(value: string | null): string | null {
  if (value === null) return null;
  const match = value.match(/^=\?base64\?(.*)\?=$/);
  if (!match) return value;
  try {
    const bin = atob(match[1]);
    const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
}

function generateUserCode() {
  const bytes = new Uint8Array(8);
  crypto.getRandomValues(bytes);
  const chars = [...bytes].map((b) => USER_CODE_ALPHABET[b % USER_CODE_ALPHABET.length]);
  return `${chars.slice(0, 4).join("")}-${chars.slice(4).join("")}`;
}

/** Uppercases and re-hyphenates a user code as typed by a person. */
export function normalizeUserCode(input: string) {
  const letters = input.toUpperCase().replace(/[^A-Z]/g, "");
  return letters.length === 8 ? `${letters.slice(0, 4)}-${letters.slice(4)}` : null;
}

/** Self-reported client names: printable, short, single line. */
function sanitizeName(name: string | null) {
  const cleaned = name?.replace(/[^\p{L}\p{N} ._()-]/gu, "").trim().slice(0, 60);
  return cleaned || undefined;
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

function tooManyRequests(retryAfterMs: number) {
  return json({ error: "too_many_requests" }, 429, {
    ...PUBLIC_CORS,
    "Retry-After": String(Math.max(1, Math.ceil(retryAfterMs / 1000))),
  });
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

const MAX_METADATA_BYTES = 10_000;

/**
 * Fetches a client ID metadata document (MCP 2025-11-25). Only called for
 * hosts in `clientMetadataDocumentHosts`.
 */
async function fetchClientMetadata(clientId: string) {
  try {
    const response = await fetch(clientId, {
      headers: { Accept: "application/json" },
      redirect: "error",
      signal: AbortSignal.timeout(5000),
    });
    if (!response.ok || !response.body) return null;
    const text = await readCapped(response.body, MAX_METADATA_BYTES);
    if (text === null) return null;
    const body = JSON.parse(text);
    if (!isObject(body) || body.client_id !== clientId) return null;
    const parsed = parseClientMetadata(body);
    return "error" in parsed ? null : parsed.client;
  } catch {
    return null;
  }
}

/** Reads a stream as text, giving up once it exceeds `maxBytes`. */
async function readCapped(stream: ReadableStream<Uint8Array>, maxBytes: number) {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > maxBytes) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(bytes);
}

export type { JSONSchema };
