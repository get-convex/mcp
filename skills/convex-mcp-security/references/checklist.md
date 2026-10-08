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

## 2. Functions the tools call (Critical if wrong)

- [ ] Every function that accepts a `userId` argument is
      `internalQuery`/`internalMutation`/`internalAction`. A **public**
      function taking `userId` is callable by anyone from any Convex client.
      This is the most common real bug.
- [ ] Every ID from the model is normalized (`ctx.db.normalizeId`) and
      **ownership-checked against `userId`** before read or write, including
      IDs of child objects (a comment ID in a project the user can't see).
- [ ] Writes into a container (add item to list/project/channel) check the
      user may write to *that container*.
- [ ] Search/list functions filter by the user (index on owner) before
      `take()`, not after (filtering after a `take` can also return other
      users' rows if the filter is wrong).
- [ ] No tool calls admin/internal maintenance functions (`internal.admin.*`,
      migrations, billing overrides) unless explicitly intended and scoped.

## 3. What results expose (High/Medium)

- [ ] Every tool returning an object has `returns`. The component enforces
      it, so it is also the allowlist of fields that reach the agent.
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
- [ ] If a server has both: the outbound tools have
      `destructiveHint: true`, a separate write scope users can withhold,
      explicit recipient arguments (no "send to whoever the doc says"), and
      ideally a recipient allowlist (existing contacts/teammates) enforced
      server-side.
- [ ] Third-party text in results is clearly fielded (e.g.
      `{ author, body }`), not concatenated into instructions-looking prose.
- [ ] `instructions` and tool descriptions don't tell the model to follow
      directions found in content.
- [ ] No tool fetches arbitrary model-supplied URLs from the backend
      (SSRF); if needed, allowlist hosts.

## 5. Scopes and annotations (High/Low)

- [ ] Every write tool has a write scope; read tools a read scope, so a
      read-only connection is possible.
- [ ] `readOnlyHint` only on tools that truly don't write.
      `destructiveHint` on deletes, sends, payments, sharing changes, bulk
      operations. Clients decide when to ask the user based on these.
- [ ] Scope descriptions (shown on the consent page) are accurate and
      understandable.

## 6. Consent page (Medium/High)

- [ ] Requires sign-in, then returns to the same `/connect?request=…` URL
      (no open redirect via a `next=` parameter).
- [ ] Approval happens only on an explicit user click (a `POST`/action),
      never automatically on page load and never via a `GET` link.
- [ ] Shows the client name **and** the redirect host, and the scopes.
      Treat client names as untrusted text (they're self-registered): render
      as text, never HTML.
- [ ] Served with `Content-Security-Policy: frame-ancestors 'none'` (or
      `X-Frame-Options: DENY`) so it can't be clickjacked in an iframe.
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
      user (`@convex-dev/rate-limiter` keyed by `userId`).
- [ ] Bulk operations have caps.
