# MCP security checklist

## Inventory

| Tool | Calls | R/W | Whose data | `returns`? | Scope | Annotations | Returns 3rd-party text? | Sends data out? |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |

"Sends data out" = email, messages, webhooks, `fetch` to a model-chosen
URL, creating public/shareable links, inviting people, changing sharing,
payments.

## 1. Identity (Critical if wrong)

- [ ] Handlers take identity **only** from `user.userId` (third handler
      argument). No tool `args` named `userId`, `ownerId`, `email`,
      `accountId`, `teamId`/`orgId` that decide *whose* data is touched
      without a membership check.
- [ ] `getUserId` in `mcp.api({ getUserId })` returns a stable, unique ID:
      users-table ID (`getAuthUserId`) or `identity.tokenIdentifier`. Not
      `identity.subject` with more than one issuer, not email (mutable,
      reusable), not a display name.
- [ ] The ID type the tools assume matches what `getUserId` returns
      (e.g. tools cast to `Id<"users">` and `getUserId` returns users IDs —
      not `tokenIdentifier` strings).
- [ ] Multi-tenant apps: the org/team a tool acts in is either fixed per
      connection or checked for membership on every call, the same way the UI
      checks it.
- [ ] Apps with sharing/roles: internal functions call the **same** access
      helper as the UI (e.g. `requireAccess(ctx, userId, id, "edit")`), with
      the right level per tool (view/edit/admin). Prove with a third user who
      has *view* access: write tools must refuse them, read tools must work.

## 2. Functions the tools call (Critical if wrong)

- [ ] Every function a tool calls with `userId` is
      `internalQuery`/`internalMutation`/`internalAction`. A **public**
      function that *trusts* a `userId` argument is callable by anyone from
      any Convex client — the most common real bug. (A public function that
      authenticates and checks `userId` equals the caller is fine, but
      shouldn't be what tools call.)
- [ ] Every ID from the model is normalized (`ctx.db.normalizeId`) and
      **ownership-checked against `userId`** before read or write, including
      IDs of child objects (a comment ID in a project the user can't see).
- [ ] Writes into a container (add item to list/project/channel) check the
      user may write to *that container*.
- [ ] Search/list functions filter by the user (index on owner) before
      `take()`. Other filters applied *after* `take()` silently return
      incomplete results (report under Other unless it leaks data).
- [ ] No tool calls admin/internal maintenance functions (`internal.admin.*`,
      migrations, billing overrides) unless explicitly intended and scoped.

## 3. What results expose (High/Medium)

- [ ] Every tool returning an object has `returns`. The component enforces
      it (plain return values and `structuredContent`), so it is also the
      allowlist of fields that reach the agent.
- [ ] Tools using `callToolResult(...)`: review `content` blocks by hand —
      they are not validated (secrets, unexpected fields, `resource_link`
      URIs, oversized images).
- [ ] No secrets in results or error messages: tokens, password hashes,
      API keys, internal notes, other users' emails/PII.
- [ ] `ConvexError` messages don't echo other users' data ("Doc X belongs
      to bob@…").
- [ ] Lists/searches are bounded (`limit` with a max, `.take(n)`) and
      results stay small (< ~10 KB typical).

## 4. Prompt injection and exfiltration (High)

- [ ] List tools that return text written by someone other than the
      connected user (comments, messages, shared docs, emails, form
      submissions, file contents, web pages).
- [ ] List tools that send data out (see Inventory).
- [ ] If a server has both, there is a **server-enforced policy that
      doesn't depend on the model**: destination allowlists (existing
      contacts/teammates/domains), operation and value caps, and for
      consequential sends a fresh human confirmation in your app showing the
      exact recipient and payload. Annotations, scopes and fielded results
      (`{ author, body }`) help clients but are **not** mitigations by
      themselves; note residual risk even when authorization is correct.
- [ ] Consider splitting outbound tools into their own scope (or server)
      so users can connect a read-only agent.
- [ ] `instructions` and tool descriptions don't tell the model to follow
      directions found in content.
- [ ] No tool fetches arbitrary model-supplied URLs from the backend
      (SSRF); if needed, allowlist hosts.

## 4b. Downstream credentials (High)

- [ ] Inventory every third-party API the tools call and the credential
      used. Fail if a tool accepts an access token as an argument, returns
      one, forwards the MCP bearer token downstream (token passthrough), or
      uses a per-user downstream token not bound to `userId`.
- [ ] If the app brokers OAuth to a downstream service with one shared
      client ID, a new MCP client must not inherit consent another client
      obtained: require the user's consent per MCP connection.

## 5. Scopes and annotations (High/Low)

- [ ] Every write tool has a write scope; read tools a read scope, so a
      read-only connection is possible.
- [ ] `readOnlyHint` only on tools that truly don't write.
      `destructiveHint: true` on deletes, sends, payments, sharing changes,
      bulk operations. Note the MCP defaults when omitted:
      `destructiveHint: true`, `openWorldHint: true` — missing annotations
      make tools look *more* dangerous (a UX issue, Low), so set
      `destructiveHint: false` / `openWorldHint: false` where accurate.
      Clients treat annotations as untrusted hints; they are not enforcement.
- [ ] Scope descriptions (shown on the consent page) are accurate and
      understandable.

## 6. Consent page (Medium/High)

- [ ] Requires sign-in, then returns to the same `/connect?request=…` URL
      (no open redirect via a `next=` parameter).
- [ ] Approval happens only on an explicit user click (a `POST`/action),
      never automatically on page load and never via a `GET` link.
- [ ] Shows the scopes, the redirect host prominently (full redirect URI
      available), and the client name **labeled as unverified** — names are
      self-registered and can impersonate known agents. Render as text,
      never HTML; don't load remote `logo_uri` images unless the client is
      trusted. Warn when the redirect is `localhost`/loopback (any local
      program can claim it).
- [ ] Can't be framed: `Content-Security-Policy: frame-ancestors 'none'`
      (or `X-Frame-Options: DENY`) from the **production hosting config**
      (`vercel.json`, `_headers`, Next `headers()`), and/or — on hosts that
      can't set headers (Convex static hosting, static exports) — the page
      refuses to render approval UI when `window.top !== window.self`. A
      dev-server check only proves dev.
- [ ] `consentUrl` points at the real frontend (not a legacy or
      auth-provider `SITE_URL`) and `siteUrl` is the URL users connect to.
- [ ] The page navigates to the `redirectUrl` returned by `authorize`, not
      a URL built from query parameters.

## 7. Configuration (Medium)

- [ ] `siteUrl` / `CONVEX_SITE_URL` is the URL clients actually use (custom
      domain set if one is used); the app sets no `httpPrefix`.
- [ ] `allowedOrigins` empty or exact origins; never derived from the
      request.
- [ ] `clientMetadataDocumentHosts` only lists hosts you trust.
- [ ] Token TTLs not raised far above defaults (1 h access / 30 d
      refresh) without reason.
- [ ] Users can see and revoke connections (`listConnections`,
      `revokeConnection`) and API keys are shown once.
- [ ] No `console.log` of tool arguments/results that may contain personal
      data or secrets; never log bearer tokens.

## 8. Abuse and cost (Medium)

- [ ] Expensive tools (LLM calls, exports, emails) are rate limited per
      user (`@convex-dev/rate-limiter` keyed by `userId`). N/A if there are
      none.
- [ ] Bulk operations have caps; free-text inputs have length limits.
