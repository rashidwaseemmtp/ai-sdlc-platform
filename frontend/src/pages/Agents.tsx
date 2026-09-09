import { useApi } from '../api';
import { Empty, ErrorBanner } from '../ui';

interface AgentRow {
  key: string;
  name: string;
  role: string;
  context: string[];
  checks: { code: string; severity: string; description: string }[];
  grants: {
    serverKey: string;
    serverName: string;
    toolPatterns: string[];
    enabled: boolean;
    maxCallsPerRun: number;
  }[];
}

export function Agents() {
  const { data, error } = useApi<AgentRow[]>('/agents');

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Agents</h1>
          <div className="muted small">
            Read-only on purpose. An agent's prompt, output schema and quality checks are code in
            <span className="mono"> backend/src/agents/</span> — changing one is a diff someone can
            review, which is what makes the provenance on a run mean anything.
          </div>
        </div>
      </div>

      <ErrorBanner error={error} />
      {!data?.length ? <Empty>Loading…</Empty> : null}

      {data?.map((agent) => (
        <div className="card" key={agent.key}>
          <div className="spread">
            <h2 style={{ margin: 0 }}>{agent.name}</h2>
            <span className="mono muted">{agent.key}</span>
          </div>
          <p className="small">{agent.role}</p>

          <h3>Sees</h3>
          <div className="row" style={{ marginBottom: 10 }}>
            {agent.context.length
              ? agent.context.map((section) => <span key={section} className="badge muted">{section}</span>)
              : <span className="muted small">only the project card</span>}
          </div>

          <h3>Tools it may call</h3>
          <div className="row" style={{ marginBottom: 10 }}>
            {agent.grants.length ? (
              agent.grants.map((grant) => (
                <span key={grant.serverKey} className={`badge ${grant.enabled ? 'info' : 'muted'}`}>
                  {grant.serverKey}: {grant.toolPatterns.join(', ')}
                  {grant.enabled ? '' : ' (off)'}
                </span>
              ))
            ) : (
              <span className="muted small">none — it works from project state alone</span>
            )}
          </div>

          <h3>Checks the platform runs on its answer</h3>
          <table>
            <tbody>
              {agent.checks.map((check) => (
                <tr key={check.code}>
                  <td style={{ width: 90 }}>
                    <span className={`badge ${check.severity === 'HARD' ? 'danger' : 'warn'}`}>
                      {check.severity.toLowerCase()}
                    </span>
                  </td>
                  <td className="mono small" style={{ width: 240 }}>{check.code}</td>
                  <td className="small">{check.description}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <div className="field-hint">
            A failed HARD check throws the answer away before anything is written. A failed SOFT
            check is attached to the run and shown to whoever approves the gate.
          </div>
        </div>
      ))}
    </>
  );
}
