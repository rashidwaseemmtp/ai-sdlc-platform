import { safeGet, type ApprovalDetail } from '@/lib/api';
import { Badge, ErrorBanner, StatusBadge, duration } from '@/components/ui';
import { DecisionForm } from './decision-form';

export const dynamic = 'force-dynamic';

/**
 * The human-in-the-loop screen — docs/54.
 *
 * Shows the artifact, what changed, the agent's *auditable* decision summary, the quality warnings
 * it raised about its own work, and full provenance. It never shows chain-of-thought, because the
 * platform never asks for or stores any (invariant I9).
 */
export default async function ApprovalPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const { data, error } = await safeGet<ApprovalDetail | null>(`/approvals/${id}`, null);
  const users = await safeGet<{ id: string; name: string; role: string }[]>('/users', []);

  if (error || !data) {
    return (
      <>
        <h1>Approval</h1>
        <ErrorBanner error={error ?? 'not found'} />
      </>
    );
  }

  const eligible = users.data.filter((user) => user.role === 'ADMIN' || user.role === data.requiredRole);

  return (
    <>
      <div className="row" style={{ justifyContent: 'space-between' }}>
        <div>
          <h1>{data.title}</h1>
          <p className="lede">
            <span className="mono">{data.project.key}</span> · {data.isIntervention ? 'intervention' : `${data.gate} gate`} ·
            requires <strong>{data.requiredRole}</strong>
          </p>
        </div>
        <StatusBadge status={data.status} />
      </div>

      {data.summary ? <div className="banner info">{data.summary}</div> : null}

      {data.isIntervention ? (
        <div className="banner warn">
          A workflow parked and is waiting for a person. It is still alive — resolving this resumes
          it exactly where it stopped.
        </div>
      ) : null}

      {/* The agent's own account of what it decided and why. Conclusions and evidence, not reasoning. */}
      {data.decisionSummary ? (
        <>
          <h2>Agent decision summary</h2>
          <div className="card">
            <p style={{ marginTop: 0 }}>{data.decisionSummary.summary}</p>
            <div className="row small muted">
              confidence {(data.decisionSummary.confidence * 100).toFixed(0)}%
            </div>

            {data.decisionSummary.assumptions.length ? (
              <>
                <h3 style={{ marginTop: 16 }}>Assumptions</h3>
                <ul className="small">
                  {data.decisionSummary.assumptions.map((item) => (
                    <li key={item}>{item}</li>
                  ))}
                </ul>
              </>
            ) : null}

            {data.decisionSummary.risks.length ? (
              <>
                <h3 style={{ marginTop: 16 }}>Risks</h3>
                <ul className="small">
                  {data.decisionSummary.risks.map((risk) => (
                    <li key={risk.description}>
                      <StatusBadge status={risk.severity} /> {risk.description}
                    </li>
                  ))}
                </ul>
              </>
            ) : null}

            {data.decisionSummary.tradeoffs.length ? (
              <>
                <h3 style={{ marginTop: 16 }}>Tradeoffs</h3>
                <ul className="small">
                  {data.decisionSummary.tradeoffs.map((item) => (
                    <li key={item}>{item}</li>
                  ))}
                </ul>
              </>
            ) : null}

            {data.decisionSummary.openQuestions.length ? (
              <>
                <h3 style={{ marginTop: 16 }}>Open questions</h3>
                <ul className="small">
                  {data.decisionSummary.openQuestions.map((item) => (
                    <li key={item}>{item}</li>
                  ))}
                </ul>
              </>
            ) : null}
          </div>
        </>
      ) : null}

      {data.qualityWarnings.length ? (
        <>
          <h2>Quality warnings</h2>
          <div className="card">
            <ul className="small" style={{ margin: 0 }}>
              {data.qualityWarnings.map((warning, index) => (
                <li key={index}>
                  <Badge tone="warn">{warning.code ?? 'warning'}</Badge> {warning.message}
                </li>
              ))}
            </ul>
          </div>
        </>
      ) : null}

      {data.provenance ? (
        <>
          <h2>Provenance</h2>
          <div className="card table-wrap">
            <table>
              <tbody>
                <tr>
                  <th>Agent</th>
                  <td className="mono">{data.provenance.agentKey}</td>
                  <th>Prompt</th>
                  <td className="mono">{data.provenance.promptVersion ?? '—'}</td>
                </tr>
                <tr>
                  <th>Model</th>
                  <td className="mono">{data.provenance.modelId ?? '—'}</td>
                  <th>Provider</th>
                  <td className="mono">
                    {data.provenance.providerKey ?? '—'}
                    {data.provenance.billingMode ? ` (${data.provenance.billingMode.toLowerCase()})` : ''}
                  </td>
                </tr>
                <tr>
                  <th>Cost</th>
                  <td>${(data.provenance.costUsd ?? 0).toFixed(4)}</td>
                  <th>Tokens / time</th>
                  <td>
                    {(data.provenance.tokens ?? 0).toLocaleString()} · {duration(data.provenance.durationMs)}
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
        </>
      ) : null}

      {data.lineage.length ? (
        <>
          <h2>Derived from</h2>
          <div className="card">
            <ul className="small mono" style={{ margin: 0 }}>
              {data.lineage.map((edge, index) => (
                <li key={index}>
                  {edge.relation.toLowerCase()} → {edge.name} v{edge.version}
                </li>
              ))}
            </ul>
          </div>
        </>
      ) : null}

      {data.artifact ? (
        <>
          <h2>
            Artifact — {data.artifact.kind.toLowerCase().replace(/_/g, ' ')} v{data.artifact.version}
          </h2>
          <div className="card">
            <div className="muted small mono" style={{ marginBottom: 8 }}>
              sha256 {data.artifact.sha256.slice(0, 16)}…
              {data.previousVersion ? ` · previous v${data.previousVersion.version}` : ' · first version'}
            </div>
            <pre style={{ maxHeight: 460, overflowY: 'auto' }}>
              {JSON.stringify(data.artifact.content, null, 2)}
            </pre>
          </div>
        </>
      ) : Object.keys(data.context).length ? (
        <>
          <h2>Context</h2>
          <div className="card">
            <pre style={{ maxHeight: 380, overflowY: 'auto' }}>{JSON.stringify(data.context, null, 2)}</pre>
          </div>
        </>
      ) : null}

      {data.status === 'PENDING' ? (
        <>
          <h2>Decision</h2>
          <DecisionForm
            requestId={data.requestId}
            isIntervention={data.isIntervention}
            users={eligible}
            requiredRole={data.requiredRole}
          />
        </>
      ) : (
        <div className="banner info" style={{ marginTop: 24 }}>
          This gate is already {data.status.toLowerCase().replace(/_/g, ' ')}.
        </div>
      )}
    </>
  );
}
