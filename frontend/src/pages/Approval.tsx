import { useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { post, useApi } from '../api';
import { Empty, ErrorBanner, Status, money, when } from '../ui';

interface ApprovalDetail {
  approval: {
    id: string;
    gate: string;
    title: string;
    summary: string;
    context: Record<string, unknown>;
    status: string;
    requestedAt: string;
    expiresAt: string | null;
    decidedAt: string | null;
    decidedBy: string | null;
    comment: string | null;
    changeRequests: { target: string; instruction: string; severity: string }[];
    project: { key: string; name: string };
  };
  provenance: {
    id: string; agentKey: string; phase: string; model: string; provider: string;
    costUsd: number; inputTokens: number; outputTokens: number; durationMs: number;
    summary: string | null; warnings: string[]; startedAt: string;
  }[];
}

export function Approval() {
  const { id = '' } = useParams();
  const navigate = useNavigate();
  const { data, error, reload } = useApi<ApprovalDetail>(`/approvals/${id}`);

  const [decidedBy, setDecidedBy] = useState('operator');
  const [comment, setComment] = useState('');
  const [changes, setChanges] = useState('');
  const [chosenOptionId, setChosenOptionId] = useState('');
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

  if (error) return <ErrorBanner error={error} />;
  if (!data) return <Empty>Loading…</Empty>;

  const { approval, provenance } = data;
  const context = approval.context ?? {};
  const ranked = context.ranked as { optionId: string; variant: string; name: string; weightedScore: number; strengths: string[]; weaknesses: string[] }[] | undefined;
  const variances = context.variances as { storyRef: string; primaryHours: number; independentHours: number; variancePct: number; reviewRequired: boolean; rationale: string }[] | undefined;
  const waves = context.waves as { index: number; refs: string[] }[] | undefined;

  async function decide(decision: 'APPROVED' | 'REJECTED' | 'CHANGES_REQUESTED') {
    setBusy(true);
    setActionError(null);
    try {
      await post(`/approvals/${id}/decide`, {
        decision,
        decidedBy,
        comment: comment || undefined,
        chosenOptionId: chosenOptionId || undefined,
        changeRequests:
          decision === 'CHANGES_REQUESTED'
            ? changes
                .split('\n')
                .map((line) => line.trim())
                .filter(Boolean)
                .map((line) => ({ target: approval.gate.toLowerCase(), instruction: line, severity: 'MUST' }))
            : [],
      });
      await reload();
      navigate('/approvals');
    } catch (caught) {
      setActionError((caught as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <div className="page-head">
        <div>
          <h1>{approval.title}</h1>
          <div className="muted small">
            <span className="badge info">{approval.gate.replace(/_/g, ' ').toLowerCase()}</span>{' '}
            <Link to={`/projects/${approval.project.key}`}>{approval.project.key}</Link> · raised{' '}
            {when(approval.requestedAt)}
            {approval.expiresAt ? ` · expires ${new Date(approval.expiresAt).toLocaleString()}` : ''}
          </div>
        </div>
        <Status value={approval.status} />
      </div>

      <ErrorBanner error={actionError} />

      <div className="card">
        <h2>What the agents concluded</h2>
        <p>{approval.summary}</p>
      </div>

      {ranked ? (
        <div className="card table-card">
          <table>
            <thead>
              <tr><th /><th>Option</th><th>Weighted</th><th>Strongest</th><th>Weakest</th></tr>
            </thead>
            <tbody>
              {ranked.map((option) => (
                <tr key={option.optionId}>
                  <td>
                    <input
                      type="radio"
                      style={{ width: 'auto' }}
                      name="option"
                      checked={(chosenOptionId || (context.recommendedOptionId as string)) === option.optionId}
                      onChange={() => setChosenOptionId(option.optionId)}
                    />
                  </td>
                  <td>
                    <strong>{option.variant}</strong> · {option.name}
                    {context.recommendedOptionId === option.optionId ? <span className="badge ok"> recommended</span> : null}
                  </td>
                  <td className="mono">{option.weightedScore}</td>
                  <td className="small muted">{option.strengths.join(', ').toLowerCase()}</td>
                  <td className="small muted">{option.weaknesses.join(', ').toLowerCase()}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {context.closeCall ? (
            <div className="banner warn" style={{ margin: 10 }}>
              The top two are close. This is a judgement call — read both before approving.
            </div>
          ) : null}
        </div>
      ) : null}

      {variances ? (
        <div className="card table-card">
          <table>
            <thead>
              <tr><th>Story</th><th>Primary</th><th>Independent</th><th>Variance</th><th>Verdict</th></tr>
            </thead>
            <tbody>
              {variances.map((variance) => (
                <tr key={variance.storyRef}>
                  <td className="mono">{variance.storyRef}</td>
                  <td className="mono">{variance.primaryHours}h</td>
                  <td className="mono">{variance.independentHours}h</td>
                  <td className="mono">{(variance.variancePct * 100).toFixed(0)}%</td>
                  <td>
                    {variance.reviewRequired ? <Status value="CHANGES_REQUESTED" /> : <Status value="APPROVED" />}
                    <div className="muted small">{variance.rationale}</div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}

      {waves ? (
        <div className="card">
          <h2>Delivery waves</h2>
          {waves.map((wave) => (
            <div key={wave.index} className="row" style={{ marginBottom: 6 }}>
              <strong className="small">Wave {wave.index + 1}</strong>
              {wave.refs.map((ref) => <span key={ref} className="badge muted">{ref}</span>)}
            </div>
          ))}
        </div>
      ) : null}

      <div className="card">
        <h2>Provenance</h2>
        <div className="muted small" style={{ marginBottom: 8 }}>
          The agent runs behind this gate — which agent, which model, what it cost.
        </div>
        <table>
          <thead>
            <tr><th>Agent</th><th>Phase</th><th>Model</th><th>Tokens</th><th>Cost</th><th>Conclusion</th></tr>
          </thead>
          <tbody>
            {provenance.map((run) => (
              <tr key={run.id}>
                <td className="mono">{run.agentKey}</td>
                <td className="muted small">{run.phase || '—'}</td>
                <td className="small">{run.provider}/{run.model}</td>
                <td className="mono small">{(run.inputTokens + run.outputTokens).toLocaleString()}</td>
                <td className="mono small">{money(run.costUsd)}</td>
                <td className="small">
                  {run.summary}
                  {run.warnings?.length ? (
                    <ul style={{ margin: '4px 0 0 16px' }} className="muted">
                      {run.warnings.map((warning, index) => <li key={index}>{warning}</li>)}
                    </ul>
                  ) : null}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {approval.status === 'PENDING' ? (
        <div className="card">
          <h2>Your decision</h2>
          <div className="grid">
            <label>
              <span>Decided by</span>
              <input value={decidedBy} onChange={(event) => setDecidedBy(event.target.value)} />
            </label>
            <label>
              <span>Comment</span>
              <input value={comment} onChange={(event) => setComment(event.target.value)} placeholder="Optional" />
            </label>
          </div>
          <label>
            <span>Changes to request — one per line</span>
            <textarea
              value={changes}
              onChange={(event) => setChanges(event.target.value)}
              placeholder={'US-103 needs an edge case for an already-deleted record\nSplit US-107; it is XL'}
            />
            <div className="field-hint">
              These go back to the agent verbatim on the next revision. Be specific — vague feedback
              produces a vague revision, and the revise loop is bounded.
            </div>
          </label>
          <div className="row">
            <button className="primary" disabled={busy} onClick={() => void decide('APPROVED')}>Approve</button>
            <button disabled={busy || !changes.trim()} onClick={() => void decide('CHANGES_REQUESTED')}>
              Request changes
            </button>
            <button className="danger" disabled={busy} onClick={() => void decide('REJECTED')}>Reject</button>
          </div>
          <div className="field-hint" style={{ marginTop: 6 }}>
            Rejecting parks the project for a person to pick up. Requesting changes sends it back to
            the agent.
          </div>
        </div>
      ) : (
        <div className="card">
          <h2>Decision</h2>
          <div className="row">
            <Status value={approval.status} />
            <span className="muted small">
              by {approval.decidedBy ?? '—'} · {when(approval.decidedAt)}
            </span>
          </div>
          {approval.comment ? <p>{approval.comment}</p> : null}
          {approval.changeRequests.length ? (
            <ul style={{ margin: '8px 0 0 18px' }}>
              {approval.changeRequests.map((change, index) => (
                <li key={index}>[{change.severity}] {change.instruction}</li>
              ))}
            </ul>
          ) : null}
        </div>
      )}
    </>
  );
}
