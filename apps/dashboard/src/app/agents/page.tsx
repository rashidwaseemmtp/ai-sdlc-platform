import { safeGet, type AgentRow } from '@/lib/api';
import { Badge, Empty, ErrorBanner } from '@/components/ui';

export const dynamic = 'force-dynamic';

export default async function Agents() {
  const { data, error } = await safeGet<AgentRow[]>('/agents', []);

  return (
    <>
      <h1>Agents</h1>
      <p className="lede">
        Each agent declares a capability requirement, not a vendor. The router picks the model, and
        the grant matrix decides what it can touch.
      </p>
      <ErrorBanner error={error} />

      {data.some((a) => a.canMerge) ? (
        <div className="banner danger">
          An agent holds the <code>pull_request.merge</code> scope. On a default installation nobody
          does — a human merges.
        </div>
      ) : (
        <div className="banner info">
          No agent holds <code>pull_request.merge</code>. Merging is a human act on this installation.
        </div>
      )}

      {data.length === 0 ? <Empty>No agents registered.</Empty> : (
        <div className="grid cols-2">
          {data.map((agent) => (
            <div className="card" key={agent.key}>
              <div className="row" style={{ justifyContent: 'space-between' }}>
                <strong className="mono">{agent.key}</strong>
                {agent.failed > 0 ? <Badge tone="danger">{agent.failed} failed</Badge> : <Badge tone="ok">healthy</Badge>}
              </div>
              <div className="muted small" style={{ marginTop: 6 }}>
                {agent.routing?.capability ?? '—'} · floor {agent.routing?.minimumTier ?? '—'}
                {agent.routing?.effort ? ` · effort ${agent.routing.effort}` : ''}
              </div>
              <div className="small" style={{ marginTop: 10 }}>
                {agent.runs} run(s) · ${agent.costUsd.toFixed(4)}
              </div>
              <div style={{ marginTop: 10 }}>
                <div className="stat-label">Tool grants</div>
                {agent.grants.length === 0 ? (
                  <div className="muted small">none — this agent reasons only</div>
                ) : (
                  <ul className="small mono" style={{ margin: '6px 0 0', paddingLeft: 18 }}>
                    {agent.grants.map((g, i) => (
                      <li key={i}>{g.server}: {g.tools}</li>
                    ))}
                  </ul>
                )}
              </div>
            </div>
          ))}
        </div>
      )}
    </>
  );
}
