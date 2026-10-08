# Designing an app's MCP tool surface

An agent sees only your tool names, descriptions and schemas. It picks tools
by reading them, fills arguments from the conversation, and reads your
results back into its context. Design for that reader.

## 1. Start from user jobs, not endpoints

List what users actually do in the app ("add a task to a project", "what's
due this week", "share a doc with Sam"). Each frequent job should be **one
tool call**, two at most. Then check coverage: can the agent find the thing
the user names, read it, and do the common writes?

A good surface for a typical app is **5-15 tools**. More than ~20 hurts tool
selection; split by scope or drop rarely used ones.

| Instead of | Prefer |
| --- | --- |
| `getProject`, `listProjects`, `getTasksByProject` | `list_projects`, `search_tasks({ project?, status?, dueBefore? })` |
| `createTask` + `assignTask` + `setDueDate` | `create_task({ title, project, assignee?, due? })` |
| `updateTask({ id, patch: any })` | `update_task({ id, title?, status?, due? })` with explicit fields |
| exposing `internal.admin.*` | nothing |

## 2. Make things findable by name

Users say "the Q3 planning doc", not `jd7f…`. Every object the agent must
act on needs a way to get from words to an ID:

- a `search_*` / `list_*` tool that accepts a free-text `query` and returns
  `id` + human label (title/name) + 1-2 disambiguating fields;
- write tools that take `id` (from those results). Optionally accept a name
  when it is unique per user, and fail with a helpful error when ambiguous.

## 3. Names and descriptions

- `snake_case`, verb first, app nouns: `search_documents`, `create_invoice`,
  `archive_project`. Same verb means the same thing across tools.
- Description = what it does, when to use it (vs. similar tools), what it
  returns, notable limits. 1-3 sentences. Write it for a model that has never
  seen the app.
- Server `instructions`: 2-5 sentences on how tools fit together ("Use
  search_tasks to find IDs before update_task. Dates are ISO 8601 in the
  user's time zone.").

## 4. Arguments

- Few, flat, typed. Use `v.union(v.literal(...))` for enums so they become
  JSON Schema `enum`s. Optional filters instead of many variant tools.
- Use `v.string()` for IDs coming from the model and validate with
  `ctx.db.normalizeId` + ownership check in the internal function; a bad ID
  should produce a clear `ConvexError("No task with id …")`.
- Dates as ISO strings, money as `{ amount, currency }` or minor units:
  say which in the description.
- Every list/search takes `limit` (default ~20, max ~100) and returns at most
  that; add a cursor only when users genuinely page.

## 5. Results

- Add `returns` validators to data tools: clients get `outputSchema` and
  `structuredContent`.
- Return the fields the agent needs to answer or chain the next call: `id`,
  label, status, key dates, a URL into the app when one exists. Not raw
  documents.
- Keep results small (aim < ~10 KB). Truncate long text with a note on how
  to get more.
- Writes return the resulting object so the agent can confirm to the user.

## 6. Errors

Throw `ConvexError("message for the model")` for expected failures (not
found, not allowed, invalid state). Make the message say what to do next
("No project named 'Q3'. Call list_projects to see project names."). Other
exceptions are hidden from the agent and logged.

## 7. Safety: scopes and annotations

- Annotate every tool: `readOnlyHint: true` for reads;
  `destructiveHint: true` for deletes, sends, payments, anything
  irreversible or visible to other people; `idempotentHint: true` when
  repeating is harmless. Clients use these to decide when to ask the user.
- Scopes: at minimum split read vs. write (`<area>:read`, `<area>:write`)
  so users can connect a read-only agent. Keep descriptions human-readable;
  they appear on the consent page.
- Every handler acts as `user.userId` only. Reuse the app's existing
  authorization helpers in the internal functions; if the app has
  orgs/teams, check membership exactly as the UI path does.
- Think twice about tools that email, invite, pay, publish or delete in bulk.
  If included: destructive annotation, explicit arguments, and a write scope
  users can withhold.

## 8. Proposal format

Present this to the user before implementing:

| Tool | Description | Args | Returns | Scope | Annotations |
| --- | --- | --- | --- | --- | --- |
| `search_tasks` | Find the user's tasks by text, project or status… | `query?`, `project?`, `status?`, `limit?` | `{ tasks: [{ id, title, project, status, due }] }` | `tasks:read` | readOnly |

Then: **left out** (and why), **open questions** (e.g. "should agents be able
to delete projects?"), and the server `instructions` text.
