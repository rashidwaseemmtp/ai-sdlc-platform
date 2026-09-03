/** Shared presentational primitives. Deliberately small — status legibility over decoration. */

export function Badge({ children, tone = 'muted' }: { children: React.ReactNode; tone?: 'ok' | 'warn' | 'danger' | 'info' | 'muted' }) {
  return <span className={`badge ${tone}`}>{children}</span>;
}

const STATUS_TONES: Record<string, 'ok' | 'warn' | 'danger' | 'info' | 'muted'> = {
  SUCCEEDED: 'ok', DONE: 'ok', APPROVED: 'ok', PASS: 'ok', COMPLETED: 'ok', PASSED: 'ok', ACTIVE: 'info',
  RUNNING: 'info', IN_PROGRESS: 'info', REVIEW: 'info', IN_REVIEW: 'info', IN_QA: 'info', PENDING: 'warn',
  CHANGES_REQUESTED: 'warn', DRAFT: 'muted', PLANNED: 'muted', SKIPPED: 'muted',
  FAILED: 'danger', REJECTED: 'danger', FAIL: 'danger', ERROR: 'danger', EXPIRED: 'danger',
  BUDGET_EXCEEDED: 'danger', INVALID_OUTPUT: 'danger', PERMISSION_DENIED: 'danger',
  HUMAN_INTERVENTION_REQUIRED: 'danger', CRITICAL: 'danger', HIGH: 'danger', MEDIUM: 'warn', LOW: 'muted',
};

export function StatusBadge({ status }: { status: string }) {
  return <Badge tone={STATUS_TONES[status] ?? 'muted'}>{status.replace(/_/g, ' ').toLowerCase()}</Badge>;
}

export function Stat({ label, value, hint }: { label: string; value: React.ReactNode; hint?: string }) {
  return (
    <div className="card">
      <div className="stat-label">{label}</div>
      <div className="stat">{value}</div>
      {hint ? <div className="muted small">{hint}</div> : null}
    </div>
  );
}

export function Empty({ children }: { children: React.ReactNode }) {
  return <div className="empty">{children}</div>;
}

export function ErrorBanner({ error }: { error?: string }) {
  if (!error) return null;
  return <div className="banner danger">Could not load this panel: {error}</div>;
}

export function duration(ms: number | null | undefined): string {
  if (!ms) return '—';
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  return `${Math.floor(ms / 60_000)}m ${Math.round((ms % 60_000) / 1000)}s`;
}

export function when(iso: string | null | undefined): string {
  if (!iso) return '—';
  const diff = Date.now() - new Date(iso).getTime();
  if (diff < 60_000) return 'just now';
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`;
  return new Date(iso).toLocaleDateString();
}
