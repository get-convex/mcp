import "./App.css";
import { useAuthActions } from "@convex-dev/auth/react";
import {
  Authenticated,
  AuthLoading,
  Unauthenticated,
  useAction,
  useMutation,
  useQuery,
} from "convex/react";
import { useEffect, useState } from "react";
import { api } from "../convex/_generated/api";

const MCP_URL = `${import.meta.env.VITE_CONVEX_SITE_URL}/mcp`;

export default function App() {
  const isConsent = window.location.pathname === "/connect";
  return (
    <main>
      <AuthLoading>Loading…</AuthLoading>
      <Unauthenticated>
        <SignIn reason={isConsent ? "Sign in to connect your agent." : undefined} />
      </Unauthenticated>
      <Authenticated>{isConsent ? <Consent /> : <Home />}</Authenticated>
    </main>
  );
}

function SignIn({ reason }: { reason?: string }) {
  const { signIn } = useAuthActions();
  return (
    <section className="card">
      <h1>Todos</h1>
      <p>{reason ?? "An example app with an MCP server built in."}</p>
      <button onClick={() => void signIn("anonymous")}>Sign in as a guest</button>
    </section>
  );
}

/**
 * The OAuth consent page. The MCP component's /authorize endpoint sends the
 * user here as /connect?request=…; approving sends them back to the agent.
 */
function Consent() {
  // Never render approval UI inside another site's frame (clickjacking).
  // Prefer the `frame-ancestors 'none'` header where your host can set it;
  // this check also covers static hosts that can't.
  if (window.top !== window.self) {
    return (
      <section className="card">
        <h1>Open this page directly</h1>
        <p>For your security, approving an agent can't be done inside another site.</p>
      </section>
    );
  }
  return <ConsentPrompt />;
}

function ConsentPrompt() {
  const [requestId, setRequestId] = useState(
    () => new URLSearchParams(window.location.search).get("request") ?? "",
  );
  if (!requestId) return <EnterCode onFound={setRequestId} />;
  return <Approve requestId={requestId} />;
}

/** For agents that showed the user a code instead of a link. */
function EnterCode({ onFound }: { onFound: (requestId: string) => void }) {
  const find = useMutation(api.mcp.findAuthRequest);
  const [code, setCode] = useState("");
  const [error, setError] = useState<string | null>(null);
  return (
    <section className="card">
      <h1>Connect an agent</h1>
      <p>Enter the code your agent is showing you.</p>
      <form
        className="row"
        onSubmit={(e) => {
          e.preventDefault();
          setError(null);
          find({ userCode: code })
            .then((id) => (id ? onFound(id) : setError("That code isn't valid or has expired.")))
            .catch((err: unknown) => setError(err instanceof Error ? err.message : String(err)));
        }}
      >
        <input value={code} onChange={(e) => setCode(e.target.value)} placeholder="ABCD-EFGH" />
        <button type="submit">Continue</button>
      </form>
      {error && <p className="error">{error}</p>}
    </section>
  );
}

function Approve({ requestId }: { requestId: string }) {
  const request = useQuery(api.mcp.getAuthRequest, { requestId });
  const authorize = useAction(api.mcp.authorize);
  const [busy, setBusy] = useState(false);
  const [confirmed, setConfirmed] = useState(false);
  const [done, setDone] = useState<"approved" | "denied" | null>(null);
  const [error, setError] = useState<string | null>(null);

  if (done) {
    return (
      <section className="card">
        <h1>{done === "approved" ? "Connected" : "Denied"}</h1>
        <p>
          {done === "approved"
            ? "You can go back to your agent now. You can disconnect it any time from Todos."
            : "Your agent was not given access."}
        </p>
      </section>
    );
  }
  if (request === undefined) return <p>Loading…</p>;
  if (request === null || request.status !== "pending") {
    return (
      <section className="card">
        <h1>Link expired</h1>
        <p>Start connecting again from your agent.</p>
      </section>
    );
  }
  const isDevice = request.kind === "device";
  const decide = async (approve: boolean) => {
    setBusy(true);
    try {
      const { redirectUrl } = await authorize({ requestId, approve });
      if (redirectUrl) window.location.assign(redirectUrl);
      else setDone(approve ? "approved" : "denied");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setBusy(false);
    }
  };
  // Client names are self-reported, so they're labeled as unverified.
  const name = request.clientName ?? "An MCP client";
  return (
    <section className="card">
      <h1>Connect an agent?</h1>
      <p>
        <strong>{name}</strong> <span className="muted">(name not verified)</span> wants to use{" "}
        {request.serverName} on your behalf. It will be able to:
      </p>
      <ul className="scopes">
        {request.scopes.map((s) => (
          <li key={s.name}>{s.description}</li>
        ))}
      </ul>
      {isDevice ? (
        <>
          <p>
            Your agent should be showing this code: <code className="usercode">{request.userCode}</code>
          </p>
          <label className="row">
            <input type="checkbox" checked={confirmed} onChange={(e) => setConfirmed(e.target.checked)} />
            I started this from my own agent, and it shows the same code.
          </label>
          <p className="muted">If someone sent you this link, deny it.</p>
        </>
      ) : (
        <p className="muted">
          You'll be sent back to <code>{request.redirectUri && new URL(request.redirectUri).host}</code>.
        </p>
      )}
      {error && <p className="error">{error}</p>}
      <div className="row">
        <button disabled={busy} onClick={() => void decide(false)}>
          Deny
        </button>
        <button
          className="primary"
          disabled={busy || (isDevice && !confirmed)}
          onClick={() => void decide(true)}
        >
          Allow
        </button>
      </div>
    </section>
  );
}

function Home() {
  const { signOut } = useAuthActions();
  return (
    <>
      <header className="row spread">
        <h1>Todos</h1>
        <button onClick={() => void signOut()}>Sign out</button>
      </header>
      <Lists />
      <Agents />
    </>
  );
}

function Lists() {
  const lists = useQuery(api.lists.mine);
  const ensureDefault = useMutation(api.lists.ensureDefault);
  const join = useMutation(api.lists.join);
  const [selected, setSelected] = useState<string | null>(null);
  const [code, setCode] = useState("");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (lists && lists.length === 0) void ensureDefault();
  }, [lists, ensureDefault]);

  const current = lists?.find((l) => l.id === selected) ?? lists?.[0];
  return (
    <>
      <section className="card">
        <div className="row">
          {lists?.map((l) => (
            <button
              key={l.id}
              className={l.id === current?.id ? "primary" : ""}
              onClick={() => setSelected(l.id)}
            >
              {l.name} <span className="muted">· {l.role}</span>
            </button>
          ))}
        </div>
        <form
          className="row"
          onSubmit={(e) => {
            e.preventDefault();
            setError(null);
            join({ code: code.trim() })
              .then((id) => {
                setSelected(id);
                setCode("");
              })
              .catch((err: unknown) =>
                setError(err instanceof Error ? err.message : String(err)),
              );
          }}
        >
          <input value={code} onChange={(e) => setCode(e.target.value)} placeholder="Join a list with a share code" />
          <button type="submit">Join</button>
        </form>
        {error && <p className="error">{error}</p>}
      </section>
      {current && <Todos list={current} />}
    </>
  );
}

type ListInfo = {
  id: string;
  name: string;
  role: "owner" | "editor" | "viewer";
  editorCode?: string;
  viewerCode?: string;
};

function Todos({ list }: { list: ListInfo }) {
  const todos = useQuery(api.todos.list, { listId: list.id });
  const add = useMutation(api.todos.add);
  const toggle = useMutation(api.todos.toggle);
  const [text, setText] = useState("");
  const canEdit = list.role !== "viewer";
  return (
    <section className="card">
      <h2>{list.name}</h2>
      {list.role === "owner" && (
        <p className="muted">
          Share: editors use <code>{list.editorCode}</code>, viewers use <code>{list.viewerCode}</code>
        </p>
      )}
      {canEdit && (
        <form
          className="row"
          onSubmit={(e) => {
            e.preventDefault();
            if (text.trim()) void add({ listId: list.id, text: text.trim() });
            setText("");
          }}
        >
          <input value={text} onChange={(e) => setText(e.target.value)} placeholder="Add a todo" />
          <button type="submit">Add</button>
        </form>
      )}
      <ul className="todos">
        {todos?.map((t) => (
          <li key={t._id}>
            <label>
              <input
                type="checkbox"
                checked={t.done}
                disabled={!canEdit}
                onChange={() => void toggle({ id: t._id })}
              />
              <span className={t.done ? "done" : ""}>{t.text}</span>
            </label>
          </li>
        ))}
        {todos?.length === 0 && <li className="muted">Nothing yet — ask your agent to add one.</li>}
      </ul>
    </section>
  );
}

/** "Connected agents": how to connect, existing connections, API keys. */
function Agents() {
  const connections = useQuery(api.mcp.listConnections);
  const revoke = useMutation(api.mcp.revokeConnection);
  const createApiKey = useAction(api.mcp.createApiKey);
  const [newKey, setNewKey] = useState<string | null>(null);
  return (
    <section className="card">
      <h2>Use with your agent</h2>
      <p>
        Add this MCP server URL to Claude, ChatGPT, Cursor or any MCP client. You'll be asked to
        sign in here and approve it.
      </p>
      <pre>{MCP_URL}</pre>
      <p className="muted">
        For CLIs, create an API key and run{" "}
        <code>claude mcp add --transport http todos {MCP_URL} --header "Authorization: Bearer &lt;key&gt;"</code>
      </p>
      <button
        onClick={() =>
          void createApiKey({ name: `API key ${new Date().toLocaleString()}` }).then((r) =>
            setNewKey(r.apiKey),
          )
        }
      >
        Create API key
      </button>
      {newKey && (
        <p>
          Copy it now, it won't be shown again: <code>{newKey}</code>
        </p>
      )}
      <h3>Connected agents</h3>
      <ul className="connections">
        {connections?.map((c) => (
          <li key={c.id} className="row spread">
            <span>
              <strong>{c.name}</strong>{" "}
              <span className="muted">
                {c.kind === "apiKey" ? "API key" : "OAuth"} · {c.scopes.join(", ") || "all tools"}
                {c.lastUsedAt ? ` · last used ${new Date(c.lastUsedAt).toLocaleString()}` : ""}
              </span>
            </span>
            <button onClick={() => void revoke({ id: c.id })}>Disconnect</button>
          </li>
        ))}
        {connections?.length === 0 && <li className="muted">No agents connected yet.</li>}
      </ul>
    </section>
  );
}
