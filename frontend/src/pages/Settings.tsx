import { useEffect, useState } from 'react';
import { put, useApi } from '../api';
import { Empty, ErrorBanner } from '../ui';

interface ModeInfo {
  mode: string;
  label: string;
  summary: string;
  needsApiKey: boolean;
  supportsTools: boolean;
  suggestedModels: string[];
  defaultBaseUrl: string;
  cli: { command: string; loginCommand: string; plans: string } | null;
}

interface ProviderInfo {
  key: string;
  displayName: string;
  modes: ModeInfo[];
}

interface PairConfig {
  apiKey: string;
  apiKeySet: boolean;
  baseUrl: string;
  model: string;
  command: string;
  inputCostPer1M: number;
  outputCostPer1M: number;
}

interface SettingsShape {
  providers: Record<string, PairConfig>;
  active: { provider: string; mode: string };
  toolProvider?: { provider: string; mode: string };
  effort: string;
  maxOutputTokens: number;
  limits: {
    projectCostUsd: number;
    agentCostUsd: number;
    backlogRevisions: number;
    architectureRounds: number;
    estimationVariance: number;
    prFixIterations: number;
    qaFixIterations: number;
    toolCallsPerRun: number;
  };
  github: { token: string; tokenSet: boolean; repository: string; defaultBranch: string; push: boolean };
  runner: { pollMs: number; maxConcurrentRuns: number };
  gates: Record<string, { requireApproval: boolean; timeoutHours: number }>;
}

interface Payload {
  settings: SettingsShape;
  providers: ProviderInfo[];
  gates: string[];
}

interface Probe {
  id: string;
  provider: string;
  command: string;
  installed: boolean;
  detail: string;
  signedIn: boolean | null;
  status: string;
  loginCommand: string;
  plans: string;
}

const pairId = (provider: string, mode: string) => `${provider}:${mode}`;

export function Settings() {
  const { data, error, reload } = useApi<Payload>('/settings');
  const probes = useApi<Probe[]>('/providers/probe');
  const [form, setForm] = useState<SettingsShape | null>(null);
  const [keys, setKeys] = useState<Record<string, string>>({});
  const [githubToken, setGithubToken] = useState('');
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  useEffect(() => {
    if (data) setForm(data.settings);
  }, [data]);

  if (error) return <ErrorBanner error={error} />;
  if (!data || !form) return <Empty>Loading…</Empty>;

  const activeMode = data.providers
    .find((provider) => provider.key === form.active.provider)
    ?.modes.find((mode) => mode.mode === form.active.mode);
  const needsToolProvider = activeMode ? !activeMode.supportsTools : false;

  function setPair(id: string, patch: Partial<PairConfig>) {
    if (!form) return;
    setForm({ ...form, providers: { ...form.providers, [id]: { ...form.providers[id]!, ...patch } } });
  }

  async function save(event: React.FormEvent) {
    event.preventDefault();
    if (!form) return;
    setSaving(true);
    setSaveError(null);
    setSaved(false);
    try {
      const providers: Record<string, Partial<PairConfig>> = {};
      for (const [id, config] of Object.entries(form.providers)) {
        providers[id] = { ...config, apiKey: keys[id] ?? '' };
      }
      await put('/settings', {
        ...form,
        providers,
        github: { ...form.github, token: githubToken },
      });
      setKeys({});
      setGithubToken('');
      setSaved(true);
      await reload();
    } catch (caught) {
      setSaveError((caught as Error).message);
    } finally {
      setSaving(false);
    }
  }

  return (
    <form onSubmit={save}>
      <div className="page-head">
        <div>
          <h1>Settings</h1>
          <div className="muted small">
            Everything configurable lives here — there is no config file and no environment variable
            to edit. Changes take effect on the runner's next tick.
          </div>
        </div>
        <button className="primary" type="submit" disabled={saving}>
          {saving ? 'Saving…' : 'Save'}
        </button>
      </div>

      <ErrorBanner error={saveError} />
      {saved ? <div className="banner ok">Saved.</div> : null}

      {/* ── which entitlement answers ─────────────────────────────────── */}
      <fieldset>
        <legend>Active entitlement</legend>
        <div className="field-hint" style={{ marginBottom: 10 }}>
          Configure every provider below and leave them configured. Exactly one pair is active at a
          time — switching from metered billing to a subscription is this dropdown, nothing else.
        </div>

        <div className="grid">
          <label>
            <span>Provider</span>
            <select
              value={form.active.provider}
              onChange={(event) => {
                const provider = data.providers.find((candidate) => candidate.key === event.target.value)!;
                setForm({
                  ...form,
                  active: { provider: provider.key, mode: provider.modes[0]!.mode },
                });
              }}
            >
              {data.providers.map((provider) => (
                <option key={provider.key} value={provider.key}>
                  {provider.displayName}
                </option>
              ))}
            </select>
          </label>

          <label>
            <span>Entitlement</span>
            <select
              value={form.active.mode}
              onChange={(event) => setForm({ ...form, active: { ...form.active, mode: event.target.value } })}
            >
              {data.providers
                .find((provider) => provider.key === form.active.provider)
                ?.modes.map((mode) => (
                  <option key={mode.mode} value={mode.mode}>
                    {mode.label}
                  </option>
                ))}
            </select>
            <div className="field-hint">{activeMode?.summary}</div>
          </label>
        </div>

        {needsToolProvider ? (
          <div className="banner warn" style={{ marginTop: 10 }}>
            <strong>This entitlement cannot carry MCP tools.</strong> A tool run inside a vendor's CLI
            would bypass this platform's permission engine and audit trail, so the developer, the
            reviewers and QA cannot run on it. Name an API-key pair below and they will be sent
            there; the rest of the pipeline stays on the subscription.
          </div>
        ) : null}

        <label style={{ marginTop: 10 }}>
          <span>
            <input
              type="checkbox"
              style={{ width: 'auto', marginRight: 6 }}
              checked={Boolean(form.toolProvider)}
              onChange={(event) =>
                setForm({
                  ...form,
                  toolProvider: event.target.checked ? { provider: 'anthropic', mode: 'api' } : undefined,
                })
              }
            />
            Send agents with MCP tools to a different entitlement
          </span>
        </label>

        {form.toolProvider ? (
          <div className="grid">
            <label>
              <span>Tool provider</span>
              <select
                value={form.toolProvider.provider}
                onChange={(event) => {
                  const provider = data.providers.find((candidate) => candidate.key === event.target.value)!;
                  const supported = provider.modes.find((mode) => mode.supportsTools) ?? provider.modes[0]!;
                  setForm({ ...form, toolProvider: { provider: provider.key, mode: supported.mode } });
                }}
              >
                {data.providers
                  .filter((provider) => provider.modes.some((mode) => mode.supportsTools))
                  .map((provider) => (
                    <option key={provider.key} value={provider.key}>
                      {provider.displayName}
                    </option>
                  ))}
              </select>
            </label>
            <label>
              <span>Tool entitlement</span>
              <select
                value={form.toolProvider.mode}
                onChange={(event) =>
                  setForm({ ...form, toolProvider: { ...form.toolProvider!, mode: event.target.value } })
                }
              >
                {data.providers
                  .find((provider) => provider.key === form.toolProvider!.provider)
                  ?.modes.filter((mode) => mode.supportsTools)
                  .map((mode) => (
                    <option key={mode.mode} value={mode.mode}>
                      {mode.label}
                    </option>
                  ))}
              </select>
            </label>
          </div>
        ) : null}
      </fieldset>

      {/* ── per-provider configuration ────────────────────────────────── */}
      {data.providers.map((provider) => (
        <fieldset key={provider.key}>
          <legend>{provider.displayName}</legend>
          {provider.modes.map((mode) => {
            const id = pairId(provider.key, mode.mode);
            const config = form.providers[id];
            if (!config) return null;
            const isActive = form.active.provider === provider.key && form.active.mode === mode.mode;
            const probe = probes.data?.find((entry) => entry.id === id);

            return (
              <div
                key={id}
                className="card"
                style={{ marginBottom: 10, borderColor: isActive ? 'var(--accent)' : undefined }}
              >
                <div className="spread" style={{ marginBottom: 8 }}>
                  <strong>{mode.label}</strong>
                  <div className="row">
                    {isActive ? <span className="badge info">active</span> : null}
                    {mode.supportsTools ? (
                      <span className="badge ok">tools</span>
                    ) : (
                      <span className="badge muted">no tools</span>
                    )}
                    {probe ? (
                      <>
                        <span className={`badge ${probe.installed ? 'ok' : 'danger'}`}>
                          {probe.installed ? `CLI ${probe.detail}` : 'CLI not installed'}
                        </span>
                        {probe.installed && probe.signedIn !== null ? (
                          <span className={`badge ${probe.signedIn ? 'ok' : 'warn'}`}>
                            {probe.signedIn ? 'signed in' : 'not signed in'}
                          </span>
                        ) : null}
                      </>
                    ) : null}
                  </div>
                </div>
                <div className="muted small" style={{ marginBottom: 8 }}>{mode.summary}</div>

                {mode.cli ? (
                  <div
                    className={`banner ${probe && probe.installed && probe.signedIn === false ? 'warn' : ''}`}
                    style={probe && probe.installed && probe.signedIn === false ? {} : { background: 'var(--surface-2)' }}
                  >
                    {probe && probe.installed && probe.signedIn === false
                      ? 'This CLI is installed but not signed in, so runs on it will fail. Sign in once, in a terminal on the machine running Docker:'
                      : 'Holds no credential — the CLI owns its own login. Sign in once, inside the backend container:'}
                    <div className="mono" style={{ marginTop: 4 }}>
                      docker compose exec backend {mode.cli.loginCommand}
                    </div>
                    <div className="field-hint">
                      Covered by: {mode.cli.plans}. The login is saved on a volume, so it survives a restart.
                    </div>
                  </div>
                ) : null}

                <div className="grid">
                  {mode.needsApiKey ? (
                    <label>
                      <span>API key {config.apiKeySet ? '(set)' : '(not set)'}</span>
                      <input
                        type="password"
                        value={keys[id] ?? ''}
                        onChange={(event) => setKeys({ ...keys, [id]: event.target.value })}
                        placeholder={config.apiKeySet ? '•••••••• — leave blank to keep' : 'sk-…'}
                      />
                    </label>
                  ) : null}

                  <label>
                    <span>Model</span>
                    <input
                      value={config.model}
                      onChange={(event) => setPair(id, { model: event.target.value })}
                      list={`models-${id}`}
                      placeholder={mode.cli ? 'blank = whatever the plan gives you' : ''}
                    />
                    <datalist id={`models-${id}`}>
                      {mode.suggestedModels.filter(Boolean).map((model) => (
                        <option key={model} value={model} />
                      ))}
                    </datalist>
                  </label>

                  {mode.cli ? (
                    <label>
                      <span>CLI command</span>
                      <input
                        value={config.command}
                        onChange={(event) => setPair(id, { command: event.target.value })}
                        placeholder={mode.cli.command}
                      />
                      <div className="field-hint">Pin a specific binary, or one not on PATH.</div>
                    </label>
                  ) : (
                    <label>
                      <span>Base URL</span>
                      <input
                        value={config.baseUrl}
                        onChange={(event) => setPair(id, { baseUrl: event.target.value })}
                        placeholder={mode.defaultBaseUrl || "the provider's own endpoint"}
                      />
                    </label>
                  )}

                  <label>
                    <span>Input $ / 1M tokens</span>
                    <input
                      type="number"
                      step="0.01"
                      value={config.inputCostPer1M}
                      onChange={(event) => setPair(id, { inputCostPer1M: Number(event.target.value) })}
                    />
                  </label>
                  <label>
                    <span>Output $ / 1M tokens</span>
                    <input
                      type="number"
                      step="0.01"
                      value={config.outputCostPer1M}
                      onChange={(event) => setPair(id, { outputCostPer1M: Number(event.target.value) })}
                    />
                    <div className="field-hint">
                      {mode.cli
                        ? 'A subscription is not billed per token; runs report plan quota instead.'
                        : 'Used to price every run.'}
                    </div>
                  </label>
                </div>
              </div>
            );
          })}
        </fieldset>
      ))}

      {/* ── generation ────────────────────────────────────────────────── */}
      <fieldset>
        <legend>Generation</legend>
        <div className="grid">
          <label>
            <span>Max output tokens</span>
            <input
              type="number"
              value={form.maxOutputTokens}
              onChange={(event) => setForm({ ...form, maxOutputTokens: Number(event.target.value) })}
            />
          </label>
          <label>
            <span>Effort (Anthropic API only)</span>
            <select value={form.effort} onChange={(event) => setForm({ ...form, effort: event.target.value })}>
              {['low', 'medium', 'high', 'xhigh', 'max'].map((level) => (
                <option key={level}>{level}</option>
              ))}
            </select>
          </label>
        </div>
      </fieldset>

      {/* ── github ────────────────────────────────────────────────────── */}
      <fieldset>
        <legend>GitHub (optional)</legend>
        <div className="field-hint" style={{ marginBottom: 10 }}>
          Without a token the developer still writes code — into a git repository the backend owns,
          which you can read in the Code tab. A token adds a real branch push and a real pull
          request. The platform opens it, never an agent: the thing that opens a PR should be the
          thing that cannot merge it.
        </div>
        <div className="grid">
          <label>
            <span>Token {form.github.tokenSet ? '(set)' : '(not set)'}</span>
            <input
              type="password"
              value={githubToken}
              onChange={(event) => setGithubToken(event.target.value)}
              placeholder={form.github.tokenSet ? '•••••••• — leave blank to keep' : 'ghp_…'}
            />
          </label>
          <label>
            <span>Repository</span>
            <input
              value={form.github.repository}
              onChange={(event) => setForm({ ...form, github: { ...form.github, repository: event.target.value } })}
              placeholder="owner/repo"
            />
          </label>
          <label>
            <span>Base branch</span>
            <input
              value={form.github.defaultBranch}
              onChange={(event) =>
                setForm({ ...form, github: { ...form.github, defaultBranch: event.target.value } })
              }
            />
          </label>
          <label>
            <span>
              <input
                type="checkbox"
                style={{ width: 'auto', marginRight: 6 }}
                checked={form.github.push}
                onChange={(event) => setForm({ ...form, github: { ...form.github, push: event.target.checked } })}
              />
              Push branches and open pull requests
            </span>
            <div className="field-hint">Off by default: pushing is outward-facing.</div>
          </label>
        </div>
      </fieldset>

      {/* ── limits ────────────────────────────────────────────────────── */}
      <fieldset>
        <legend>Limits</legend>
        <div className="grid">
          {(
            [
              ['projectCostUsd', 'Project spend ceiling ($)', 'The project parks when breached. 0 disables it.'],
              ['agentCostUsd', 'Single agent ceiling ($)', ''],
              ['backlogRevisions', 'Backlog revisions', 'How many times "request changes" can go round.'],
              ['architectureRounds', 'Architecture rounds', ''],
              ['estimationVariance', 'Estimation variance threshold', '0.3 = estimators may differ by 30%.'],
              ['prFixIterations', 'Review fix rounds', 'How many times reviewers may send code back.'],
              ['qaFixIterations', 'QA fix rounds', 'How many times a failing test may send code back.'],
              ['toolCallsPerRun', 'Tool calls per agent run', 'Across every MCP server.'],
            ] as const
          ).map(([key, label, hint]) => (
            <label key={key}>
              <span>{label}</span>
              <input
                type="number"
                step={key === 'estimationVariance' ? '0.05' : '1'}
                value={form.limits[key]}
                onChange={(event) =>
                  setForm({ ...form, limits: { ...form.limits, [key]: Number(event.target.value) } })
                }
              />
              {hint ? <div className="field-hint">{hint}</div> : null}
            </label>
          ))}
        </div>
      </fieldset>

      {/* ── gates ─────────────────────────────────────────────────────── */}
      <fieldset>
        <legend>Approval gates</legend>
        <div className="field-hint" style={{ marginBottom: 10 }}>
          Switching a gate off auto-approves it the moment it opens. The decision is still written to
          the audit trail, marked automatic.
        </div>
        <table>
          <thead>
            <tr>
              <th>Gate</th>
              <th>Requires a human</th>
              <th>Timeout (hours)</th>
            </tr>
          </thead>
          <tbody>
            {data.gates.map((gate) => (
              <tr key={gate}>
                <td className="mono">{gate.replace(/_/g, ' ').toLowerCase()}</td>
                <td>
                  <input
                    type="checkbox"
                    style={{ width: 'auto' }}
                    checked={form.gates[gate]?.requireApproval ?? true}
                    onChange={(event) =>
                      setForm({
                        ...form,
                        gates: { ...form.gates, [gate]: { ...form.gates[gate]!, requireApproval: event.target.checked } },
                      })
                    }
                  />
                </td>
                <td>
                  <input
                    type="number"
                    style={{ width: 100 }}
                    value={form.gates[gate]?.timeoutHours ?? 72}
                    onChange={(event) =>
                      setForm({
                        ...form,
                        gates: { ...form.gates, [gate]: { ...form.gates[gate]!, timeoutHours: Number(event.target.value) } },
                      })
                    }
                  />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </fieldset>

      {/* ── runner ────────────────────────────────────────────────────── */}
      <fieldset>
        <legend>Runner</legend>
        <div className="grid">
          <label>
            <span>Poll interval (ms)</span>
            <input
              type="number"
              value={form.runner.pollMs}
              onChange={(event) => setForm({ ...form, runner: { ...form.runner, pollMs: Number(event.target.value) } })}
            />
          </label>
          <label>
            <span>Concurrent projects</span>
            <input
              type="number"
              value={form.runner.maxConcurrentRuns}
              onChange={(event) =>
                setForm({ ...form, runner: { ...form.runner, maxConcurrentRuns: Number(event.target.value) } })
              }
            />
          </label>
        </div>
      </fieldset>

      <button className="primary" type="submit" disabled={saving}>
        {saving ? 'Saving…' : 'Save'}
      </button>
    </form>
  );
}
