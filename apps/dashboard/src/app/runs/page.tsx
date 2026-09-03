import { safeGet, type AgentRunRow } from '@/lib/api';
import { Empty, ErrorBanner, StatusBadge, duration, when } from '@/components/ui';

export const dynamic = 'force-dynamic';

export default async function Runs() {
  const { data, error } = await safeGet<AgentRunRow[]>('/agent-runs?limit=100', []);
  return (
    <>
      <h1>Agent runs</h1>
      <p className="lede">Every execution, what it cost, and why it decided what it did.</p>
      <ErrorBanner error={error} />
      {data.length === 0 ? <Empty>No runs yet.</Empty> : (
        <div className="card table-wrap">
          <table>
            <thead><tr><th>Agent</th><th>Project</th><th>Phase</th><th>Status</th><th>Duration</th><th>Tokens</th><th>Cost</th><th>Started</th></tr></thead>
            <tbody>
              {data.map((run) => (
                <tr key={run.id}>
                  <td className="mono"><a href={`/runs/${run.id}`}>{run.agentKey}</a></td>
                  <td className="mono muted">{run.project?.key ?? '—'}</td>
                  <td className="muted small">{run.phase ?? '—'}</td>
                  <td>
                    <StatusBadge status={run.status} />
                    {run.error?.code ? <div className="small muted mono">{run.error.code}</div> : null}
                  </td>
                  <td className="muted small">{duration(run.durationMs)}</td>
                  <td className="muted small">{run.totalTokens.toLocaleString()}</td>
                  <td className="muted small">${run.totalCostUsd.toFixed(4)}</td>
                  <td className="muted small">{when(run.startedAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}
