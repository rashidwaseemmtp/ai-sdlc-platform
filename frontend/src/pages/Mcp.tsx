import { useState } from 'react';
import { del, post, put, useApi } from '../api';
import { Empty, ErrorBanner, Status, when } from '../ui';

interface Server {
  key: string;
  name: string;
  transport: string;
  command: string;
  args: string[];
  /** Names only — the values are secrets and never leave the backend. */
  env: string[];
  url: string;
  enabled: boolean;
  status: string;
  error: string | null;
  tools: { name: string; description: string }[];
  checkedAt: string | null;
}

interface Grant {
  agentKey: string;
  serverKey: string;
  toolPatterns: string[];
  enabled: boolean;
  maxCallsPerRun: number;
}

interface AgentRow {
  key: string;
  name: string;
}

const BLANK = {
  key: '',
  name: '',
  transport: 'stdio',
  command: 'npx',
  args: '',
  env: '',
  url: '',
  enabled: false,
};

export function Mcp() {
  const servers = useApi<Server[]>('/mcp/servers');
  const grants = useApi<Grant[]>('/mcp/grants');
  const agents = useApi<AgentRow[]>('/agents');

  const [creating, setCreating] = useState(false);
  const [draft, setDraft] = useState(BLANK);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<string | null>(null);

  async function act<T>(label: string, work: () => Promise<T>): Promise<void> {
    setBusy(label);
    setError(null);
    try {
      await work();
      await Promise.all([servers.reload(), grants.reload()]);
    } catch (caught) {
      setError((caught as Error).message);
    } finally {
      setBusy(null);
    }
  }

  async function create(event: React.FormEvent) {
    event.preventDefault();
    await act('create', async () => {
      await post('/mcp/servers', {
        ...draft,
        args: draft.args.split('\n').map((line) => line.trim()).filter(Boolean),
        env: Object.fromEntries(
          draft.env
            .split('\n')
            .map((line) => line.trim())
            .filter(Boolean)
            .map((line) => {
              const index = line.indexOf('=');
              return index === -1 ? [line, ''] : [line.slice(0, index), line.slice(index + 1)];
            }),
        ),
      });
      setDraft(BLANK);
      setCreating(false);
    });
  }

  return (
    <>
      <div className="page-head">
        <div>
          <h1>MCP servers &amp; grants</h1>
          <div className="muted small">
            Tool servers the agents can reach, and exactly which tools each agent may call. Deny by
            default: an agent with no grant cannot see a server's tools, let alone use them.
          </div>
        </div>
        <button className="primary" onClick={() => setCreating((open) => !open)}>
          {creating ? 'Cancel' : 'Add server'}
        </button>
      </div>

      <ErrorBanner error={error ?? servers.error} />

      <div className="banner" style={{ background: 'var(--surface-2)' }}>
        Merging, force-pushing and deleting are on a permanent deny list that no grant can override.
        They are decisions for a person, and they are exactly what a compromised agent would ask for.
      </div>

      {creating ? (
        <form className="card" onSubmit={create}>
          <div className="grid">
            <label>
              <span>Key</span>
              <input
                value={draft.key}
                onChange={(event) => setDraft({ ...draft, key: event.target.value })}
                placeholder="playwright"
                required
              />
              <div className="field-hint">Lowercase. Tools are namespaced as key.tool_name.</div>
            </label>
            <label>
              <span>Name</span>
              <input
                value={draft.name}
                onChange={(event) => setDraft({ ...draft, name: event.target.value })}
                placeholder="Playwright (browser)"
                required
              />
            </label>
            <label>
              <span>Transport</span>
              <select
                value={draft.transport}
                onChange={(event) => setDraft({ ...draft, transport: event.target.value })}
              >
                <option value="stdio">stdio (spawn a process)</option>
                <option value="http">http (streamable HTTP)</option>
              </select>
            </label>
            {draft.transport === 'stdio' ? (
              <label>
                <span>Command</span>
                <input
                  value={draft.command}
                  onChange={(event) => setDraft({ ...draft, command: event.target.value })}
                  placeholder="npx"
                />
              </label>
            ) : (
              <label>
                <span>URL</span>
                <input
                  value={draft.url}
                  onChange={(event) => setDraft({ ...draft, url: event.target.value })}
                  placeholder="https://example.com/mcp"
                />
              </label>
            )}
          </div>

          {draft.transport === 'stdio' ? (
            <label>
              <span>Arguments — one per line</span>
              <textarea
                value={draft.args}
                onChange={(event) => setDraft({ ...draft, args: event.target.value })}
                placeholder={'-y\n@playwright/mcp@latest\n--headless'}
                style={{ minHeight: 80 }}
              />
            </label>
          ) : null}

          <label>
            <span>Environment — one NAME=value per line</span>
            <textarea
              value={draft.env}
              onChange={(event) => setDraft({ ...draft, env: event.target.value })}
              placeholder="GITHUB_PERSONAL_ACCESS_TOKEN=ghp_…"
              style={{ minHeight: 60 }}
            />
            <div className="field-hint">
              Values are stored in the database and never sent back to this page. The server process
              gets these and PATH — nothing else from the backend's environment.
            </div>
          </label>

          <button className="primary" type="submit" disabled={busy === 'create'}>
            Add server
          </button>
        </form>
      ) : null}

      {!servers.data?.length ? <Empty>No MCP servers configured.</Empty> : null}

      {servers.data?.map((server) => (
        <div className="card" key={server.key}>
          <div className="spread">
            <div>
              <strong>{server.name}</strong> <span className="mono muted">{server.key}</span>
              <div className="muted small">
                {server.transport === 'stdio'
                  ? `${server.command} ${server.args.join(' ')}`
                  : server.url}
              </div>
            </div>
            <div className="row">
              <Status value={server.status} />
              <span className={`badge ${server.enabled ? 'ok' : 'muted'}`}>
                {server.enabled ? 'enabled' : 'disabled'}
              </span>
              <button
                disabled={busy === server.key}
                onClick={() =>
                  void act(server.key, () => put(`/mcp/servers/${server.key}`, { enabled: !server.enabled }))
                }
              >
                {server.enabled ? 'Disable' : 'Enable'}
              </button>
              <button disabled={busy === server.key} onClick={() => void act(server.key, () => post(`/mcp/servers/${server.key}/test`))}>
                Test connection
              </button>
              <button
                className="danger"
                disabled={busy === server.key}
                onClick={() => void act(server.key, () => del(`/mcp/servers/${server.key}`))}
              >
                Delete
              </button>
            </div>
          </div>

          {server.error ? <div className="banner danger" style={{ marginTop: 8 }}>{server.error}</div> : null}

          <div className="row small" style={{ marginTop: 8 }}>
            <span className="muted">
              {server.tools.length
                ? `${server.tools.length} tool(s) advertised`
                : 'No tools discovered yet — press "Test connection".'}
            </span>
            {server.checkedAt ? <span className="muted">checked {when(server.checkedAt)}</span> : null}
            {server.env.length ? <span className="badge muted">env: {server.env.join(', ')}</span> : null}
            {server.tools.length ? (
              <button onClick={() => setExpanded(expanded === server.key ? null : server.key)}>
                {expanded === server.key ? 'Hide tools' : 'Show tools'}
              </button>
            ) : null}
          </div>

          {expanded === server.key ? (
            <table style={{ marginTop: 8 }}>
              <tbody>
                {server.tools.map((tool) => (
                  <tr key={tool.name}>
                    <td className="mono small" style={{ width: 220 }}>{tool.name}</td>
                    <td className="small muted">{tool.description}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : null}
        </div>
      ))}

      {/* ── the grant matrix ──────────────────────────────────────────── */}
      <div className="card table-card">
        <div style={{ padding: '10px 12px 0' }}>
          <h2>Grants</h2>
          <div className="muted small">
            One row per agent and server. Patterns are globs against tool names — <span className="mono">get_*</span>,{' '}
            <span className="mono">read_file</span>, <span className="mono">*</span>. Leave a cell empty and the
            agent has no access at all.
          </div>
        </div>

        {!agents.data?.length || !servers.data?.length ? (
          <Empty>Add a server to start granting tools.</Empty>
        ) : (
          <table>
            <thead>
              <tr>
                <th>Agent</th>
                {servers.data.map((server) => (
                  <th key={server.key}>{server.key}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {agents.data.map((agent) => (
                <tr key={agent.key}>
                  <td>
                    <strong className="small">{agent.name}</strong>
                    <div className="mono muted small">{agent.key}</div>
                  </td>
                  {servers.data!.map((server) => {
                    const grant = grants.data?.find(
                      (candidate) => candidate.agentKey === agent.key && candidate.serverKey === server.key,
                    );
                    return (
                      <td key={server.key}>
                        <GrantCell
                          agentKey={agent.key}
                          serverKey={server.key}
                          grant={grant}
                          serverEnabled={server.enabled}
                          onChange={(patch) =>
                            void act(`${agent.key}/${server.key}`, () =>
                              put('/mcp/grants', {
                                agentKey: agent.key,
                                serverKey: server.key,
                                toolPatterns: patch.toolPatterns ?? grant?.toolPatterns ?? ['*'],
                                enabled: patch.enabled ?? grant?.enabled ?? true,
                                maxCallsPerRun: patch.maxCallsPerRun ?? grant?.maxCallsPerRun ?? 50,
                              }),
                            )
                          }
                          onRevoke={() =>
                            void act(`${agent.key}/${server.key}`, () =>
                              del(`/mcp/grants/${agent.key}/${server.key}`),
                            )
                          }
                        />
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </>
  );
}

function GrantCell({
  grant,
  serverEnabled,
  onChange,
  onRevoke,
}: {
  agentKey: string;
  serverKey: string;
  grant: Grant | undefined;
  serverEnabled: boolean;
  onChange: (patch: Partial<Grant>) => void;
  onRevoke: () => void;
}) {
  const [patterns, setPatterns] = useState(grant?.toolPatterns.join(', ') ?? '');

  if (!grant) {
    return (
      <button className="small" onClick={() => onChange({ toolPatterns: ['*'], enabled: true })}>
        Grant
      </button>
    );
  }

  return (
    <div>
      <div className="row" style={{ gap: 4 }}>
        <input
          type="checkbox"
          style={{ width: 'auto' }}
          checked={grant.enabled}
          onChange={(event) => onChange({ enabled: event.target.checked })}
          title={serverEnabled ? 'enabled' : 'the server itself is disabled'}
        />
        <input
          className="mono"
          style={{ width: 130, fontSize: 11 }}
          value={patterns}
          onChange={(event) => setPatterns(event.target.value)}
          onBlur={() =>
            onChange({
              toolPatterns: patterns
                .split(',')
                .map((pattern) => pattern.trim())
                .filter(Boolean),
            })
          }
        />
      </div>
      <div className="row small" style={{ gap: 4, marginTop: 2 }}>
        <input
          type="number"
          style={{ width: 60, fontSize: 11 }}
          value={grant.maxCallsPerRun}
          onChange={(event) => onChange({ maxCallsPerRun: Number(event.target.value) })}
          title="calls per run"
        />
        <button className="small" onClick={onRevoke} title="revoke">
          ✕
        </button>
      </div>
      {!serverEnabled ? <div className="field-hint">server off</div> : null}
    </div>
  );
}
