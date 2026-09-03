'use client';

import { useState } from 'react';

const API_BASE = 'http://localhost:3001/api/v1';

interface Props {
  requestId: string;
  isIntervention: boolean;
  requiredRole: string;
  users: { id: string; name: string; role: string }[];
}

/**
 * The decision form.
 *
 * "Request changes" collects *structured* change requests, not just a comment — the revising agent
 * receives them as typed input alongside the previous artifact version, so a revision is an edit
 * rather than a regeneration (docs/08 §2).
 */
export function DecisionForm({ requestId, isIntervention, requiredRole, users }: Props) {
  const [userId, setUserId] = useState(users[0]?.id ?? '');
  const [comment, setComment] = useState('');
  const [target, setTarget] = useState('');
  const [instruction, setInstruction] = useState('');
  const [severity, setSeverity] = useState<'MUST' | 'SHOULD' | 'CONSIDER'>('SHOULD');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [done, setDone] = useState<string>();

  async function submit(decision: 'APPROVED' | 'REJECTED' | 'CHANGES_REQUESTED'): Promise<void> {
    if (!userId) {
      setError(`No user with the ${requiredRole} role is available to decide this gate.`);
      return;
    }
    setBusy(true);
    setError(undefined);

    try {
      const response = await fetch(`${API_BASE}/approvals/${requestId}/decide`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          userId,
          decision,
          comment: comment || undefined,
          changeRequests:
            decision === 'CHANGES_REQUESTED' && instruction
              ? [{ target: { kind: 'story', ref: target || 'backlog' }, instruction, severity }]
              : [],
        }),
      });

      if (!response.ok) throw new Error(await response.text());
      const body = (await response.json()) as { data: { signalled: boolean } };

      setDone(
        body.data.signalled
          ? 'Decision recorded and the workflow resumed.'
          : 'Decision recorded. The workflow was unreachable, so it will pick this up from the database.',
      );
      setTimeout(() => window.location.reload(), 1200);
    } catch (caught) {
      setError((caught as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function resolveIntervention(action: string): Promise<void> {
    setBusy(true);
    setError(undefined);
    try {
      const response = await fetch(`${API_BASE}/interventions/${requestId}/resolve`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ userId, action, comment: comment || undefined }),
      });
      if (!response.ok) throw new Error(await response.text());
      setDone(`Intervention resolved: ${action}. The workflow is resuming.`);
      setTimeout(() => window.location.reload(), 1200);
    } catch (caught) {
      setError((caught as Error).message);
    } finally {
      setBusy(false);
    }
  }

  if (done) return <div className="banner info">{done}</div>;

  return (
    <div className="card">
      {error ? <div className="banner danger">{error}</div> : null}

      <div className="field">
        <label htmlFor="user">Deciding as</label>
        <select id="user" value={userId} onChange={(event) => setUserId(event.target.value)}>
          {users.length === 0 ? <option value="">no eligible user</option> : null}
          {users.map((user) => (
            <option key={user.id} value={user.id}>
              {user.name} ({user.role})
            </option>
          ))}
        </select>
      </div>

      <div className="field">
        <label htmlFor="comment">Comment</label>
        <textarea
          id="comment"
          rows={3}
          value={comment}
          onChange={(event) => setComment(event.target.value)}
          placeholder="Optional, but the next reviewer will thank you."
        />
      </div>

      {isIntervention ? (
        <div className="row">
          {['RETRY', 'RETRY_WITH_CHANGES', 'SKIP_STORY', 'ABORT_PHASE'].map((action) => (
            <button
              key={action}
              className={`btn ${action === 'RETRY' ? 'primary' : ''}`}
              disabled={busy}
              onClick={() => void resolveIntervention(action)}
            >
              {action.replace(/_/g, ' ').toLowerCase()}
            </button>
          ))}
        </div>
      ) : (
        <>
          <details style={{ marginBottom: 14 }}>
            <summary className="small muted" style={{ cursor: 'pointer', marginBottom: 8 }}>
              Add a structured change request (used when requesting changes)
            </summary>
            <div className="field">
              <label htmlFor="target">Target ref</label>
              <input
                id="target"
                value={target}
                onChange={(event) => setTarget(event.target.value)}
                placeholder="US-102"
              />
            </div>
            <div className="field">
              <label htmlFor="instruction">Instruction</label>
              <textarea
                id="instruction"
                rows={2}
                value={instruction}
                onChange={(event) => setInstruction(event.target.value)}
                placeholder="Add an edge case for a customer that is already inactive."
              />
            </div>
            <div className="field">
              <label htmlFor="severity">Severity</label>
              <select
                id="severity"
                value={severity}
                onChange={(event) => setSeverity(event.target.value as 'MUST')}
              >
                <option value="MUST">MUST</option>
                <option value="SHOULD">SHOULD</option>
                <option value="CONSIDER">CONSIDER</option>
              </select>
            </div>
          </details>

          <div className="row">
            <button className="btn primary" disabled={busy} onClick={() => void submit('APPROVED')}>
              Approve
            </button>
            <button className="btn" disabled={busy} onClick={() => void submit('CHANGES_REQUESTED')}>
              Request changes
            </button>
            <button className="btn danger" disabled={busy} onClick={() => void submit('REJECTED')}>
              Reject
            </button>
          </div>
        </>
      )}
    </div>
  );
}
