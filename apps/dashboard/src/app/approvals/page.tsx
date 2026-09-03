import { safeGet, type ApprovalListItem } from '@/lib/api';
import { Badge, Empty, ErrorBanner, StatusBadge, when } from '@/components/ui';

export const dynamic = 'force-dynamic';

export default async function Approvals() {
  const [pending, all] = await Promise.all([
    safeGet<ApprovalListItem[]>('/approvals?status=PENDING', []),
    safeGet<ApprovalListItem[]>('/approvals?status=ALL', []),
  ]);
  const decided = all.data.filter((a) => a.status !== 'PENDING').slice(0, 40);

  return (
    <>
      <h1>Approvals</h1>
      <p className="lede">
        Every consequential decision passes through here. Nothing auto-approves, and nothing
        approves on timeout.
      </p>
      <ErrorBanner error={pending.error} />

      <h2>Pending</h2>
      {pending.data.length === 0 ? (
        <Empty>Nothing is waiting for a decision.</Empty>
      ) : (
        <div className="card table-wrap">
          <table>
            <thead>
              <tr><th>Gate</th><th>Project</th><th>Title</th><th>Role</th><th>Requested</th><th>Expires</th><th /></tr>
            </thead>
            <tbody>
              {pending.data.map((a) => (
                <tr key={a.id}>
                  <td>{a.isIntervention ? <Badge tone="danger">intervention</Badge> : <Badge tone="warn">{a.gate.toLowerCase()}</Badge>}</td>
                  <td className="mono">{a.project.key}</td>
                  <td>{a.title}</td>
                  <td className="muted small">{a.requiredRole}</td>
                  <td className="muted small">{when(a.requestedAt)}</td>
                  <td className="muted small">{a.expiresAt ? new Date(a.expiresAt).toLocaleString() : '—'}</td>
                  <td><a className="btn primary" href={`/approvals/${a.id}`}>Review</a></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <h2>Decided</h2>
      {decided.length === 0 ? (
        <Empty>No decisions recorded yet.</Empty>
      ) : (
        <div className="card table-wrap">
          <table>
            <thead><tr><th>Gate</th><th>Project</th><th>Title</th><th>Outcome</th><th>When</th></tr></thead>
            <tbody>
              {decided.map((a) => (
                <tr key={a.id}>
                  <td className="muted small">{a.gate.toLowerCase()}</td>
                  <td className="mono">{a.project.key}</td>
                  <td><a href={`/approvals/${a.id}`}>{a.title}</a></td>
                  <td><StatusBadge status={a.status} /></td>
                  <td className="muted small">{when(a.requestedAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}
