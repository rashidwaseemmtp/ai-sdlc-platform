import { Link, useParams } from 'react-router-dom';
import { useApi } from '../api';
import { Empty, ErrorBanner, Status, duration, money, when } from '../ui';

interface RunRow {
  id: string; agentKey: string; phase: string; status: string; model: string; provider: string;
  costUsd: number; inputTokens: number; outputTokens: number; durationMs: number;
  summary: string | null; error: string | null; startedAt: string; authMode: string;
  quotaUnits: number; project: { key: string }; _count?: { toolCalls: number };
}

interface ToolCallRow {
  id: string; serverKey: string; toolName: string; args: unknown;
  outcome: string; reason: string | null; preview: string; durationMs: number;
}

interface RunDetail extends Omit<RunRow, 'project' | '_count'> {
  input: unknown; output: unknown; warnings: string[];
  project: { key: string; name: string };
  toolCalls: ToolCallRow[];
}

export function Runs() {
  const { id } = useParams();
  return id ? <Detail id={id} /> : <List />;
}

function List() {
  const { data, error } = useApi<RunRow[]>('/runs', 5000);

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Agent runs</h1>
          <div className="muted small">
            One row per agent execution — the provenance record for everything the pipeline produced.
          </div>
        </div>
      </div>

      <ErrorBanner error={error} />

      <div className="card table-card">
        {!data?.length ? (
          <Empty>No agent has run yet.</Empty>
        ) : (
          <table>
            <thead>
              <tr>
                <th>Agent</th><th>Project</th><th>Phase</th><th>Status</th><th>Model</th>
                <th>Tokens</th><th>Cost</th><th>Tools</th><th>Took</th><th>When</th>
              </tr>
            </thead>
            <tbody>
              {data.map((run) => (
                <tr key={run.id}>
                  <td>
                    <Link to={`/runs/${run.id}`} className="mono">{run.agentKey}</Link>
                    {run.summary ? <div className="muted small">{run.summary.slice(0, 120)}</div> : null}
                    {run.error ? <div className="small" style={{ color: 'var(--danger)' }}>{run.error}</div> : null}
                  </td>
                  <td className="mono small">{run.project.key}</td>
                  <td className="muted small">{run.phase || '—'}</td>
                  <td><Status value={run.status} /></td>
                  <td className="small">{run.model}</td>
                  <td className="mono small">{(run.inputTokens + run.outputTokens).toLocaleString()}</td>
                  <td className="mono small">
                    {run.authMode === 'subscription' ? `${run.quotaUnits} quota` : money(run.costUsd)}
                  </td>
                  <td className="mono small">{run._count?.toolCalls || '—'}</td>
                  <td className="mono small">{duration(run.durationMs)}</td>
                  <td className="muted small">{when(run.startedAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </>
  );
}

function Detail({ id }: { id: string }) {
  const { data, error } = useApi<RunDetail>(`/runs/${id}`);

  if (error) return <ErrorBanner error={error} />;
  if (!data) return <Empty>Loading…</Empty>;

  return (
    <>
      <div className="page-head">
        <div>
          <h1>{data.agentKey}</h1>
          <div className="muted small">
            <Link to={`/projects/${data.project.key}`}>{data.project.key}</Link> · {data.phase || 'no phase'} ·{' '}
            {data.provider}/{data.model} · {money(data.costUsd)} · {duration(data.durationMs)}
          </div>
        </div>
        <Status value={data.status} />
      </div>

      {data.error ? <div className="banner danger">{data.error}</div> : null}

      {data.warnings?.length ? (
        <div className="banner warn">
          <strong>Soft checks the platform ran and this output failed:</strong>
          <ul style={{ margin: '6px 0 0 18px' }}>
            {data.warnings.map((warning, index) => <li key={index}>{warning}</li>)}
          </ul>
        </div>
      ) : null}

      {data.summary ? (
        <div className="card">
          <h2>Conclusion</h2>
          <p>{data.summary}</p>
        </div>
      ) : null}

      {data.toolCalls?.length ? (
        <div className="card table-card">
          <div style={{ padding: '10px 12px 0' }}>
            <h2>Tool calls</h2>
            <div className="muted small">
              Every call this run made or was refused. A denial is recorded as loudly as a success.
            </div>
          </div>
          <table>
            <thead>
              <tr><th>Server</th><th>Tool</th><th>Outcome</th><th>Took</th><th>Result</th></tr>
            </thead>
            <tbody>
              {data.toolCalls.map((call) => (
                <tr key={call.id}>
                  <td className="mono small">{call.serverKey}</td>
                  <td className="mono small">{call.toolName}</td>
                  <td>
                    <span
                      className={`badge ${
                        call.outcome === 'ALLOWED' ? 'ok' : call.outcome === 'DENIED' ? 'danger' : 'warn'
                      }`}
                    >
                      {call.outcome.toLowerCase()}
                    </span>
                  </td>
                  <td className="mono small">{duration(call.durationMs)}</td>
                  <td className="small">
                    {call.reason ? <div style={{ color: 'var(--danger)' }}>{call.reason}</div> : null}
                    <div className="muted">{call.preview.slice(0, 300)}</div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}

      <div className="card">
        <h2>Invocation</h2>
        <div className="pre">{JSON.stringify(data.input, null, 2)}</div>
      </div>

      <div className="card">
        <h2>Output</h2>
        <div className="pre">{JSON.stringify(data.output, null, 2)}</div>
      </div>
    </>
  );
}
