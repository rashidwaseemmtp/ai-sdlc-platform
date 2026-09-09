import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useApi } from '../api';
import { Empty, ErrorBanner, Status, when } from '../ui';

interface ApprovalRow {
  id: string;
  gate: string;
  title: string;
  summary: string;
  status: string;
  requestedAt: string;
  decidedAt: string | null;
  decidedBy: string | null;
  project: { key: string; name: string };
}

export function Approvals() {
  const [filter, setFilter] = useState('PENDING');
  const { data, error } = useApi<ApprovalRow[]>(`/approvals?status=${filter}`, 5000);

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Approvals</h1>
          <div className="muted small">
            Every consequential decision stops here. Nothing is auto-approved unless you switched
            that gate off in Settings.
          </div>
        </div>
        <div className="row">
          {['PENDING', 'APPROVED', 'CHANGES_REQUESTED', 'ALL'].map((value) => (
            <button key={value} className={filter === value ? 'primary' : ''} onClick={() => setFilter(value)}>
              {value.replace(/_/g, ' ').toLowerCase()}
            </button>
          ))}
        </div>
      </div>

      <ErrorBanner error={error} />

      <div className="card table-card">
        {!data?.length ? (
          <Empty>Nothing here.</Empty>
        ) : (
          <table>
            <thead>
              <tr><th>Gate</th><th>Project</th><th>Title</th><th>Status</th><th>Raised</th><th>Decided</th></tr>
            </thead>
            <tbody>
              {data.map((approval) => (
                <tr key={approval.id}>
                  <td><span className="badge info">{approval.gate.replace(/_/g, ' ').toLowerCase()}</span></td>
                  <td className="mono">{approval.project.key}</td>
                  <td>
                    <Link to={`/approvals/${approval.id}`}>{approval.title}</Link>
                    <div className="muted small">{approval.summary.slice(0, 140)}</div>
                  </td>
                  <td><Status value={approval.status} /></td>
                  <td className="muted small">{when(approval.requestedAt)}</td>
                  <td className="muted small">{approval.decidedBy ?? '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </>
  );
}
