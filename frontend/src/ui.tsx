/** Shared presentational bits. Deliberately small — status legibility over decoration. */

import type { ReactNode } from 'react';

type Tone = 'ok' | 'warn' | 'danger' | 'info' | 'muted';

const TONES: Record<string, Tone> = {
  SUCCEEDED: 'ok', APPROVED: 'ok', COMPLETED: 'ok', DONE: 'ok', READY_FOR_DEVELOPMENT: 'ok',
  RUNNING: 'info', RUNNABLE: 'info', REVIEW: 'info', PLANNED: 'info', IN_PROGRESS: 'info',
  AWAITING_APPROVAL: 'warn', PENDING: 'warn', PAUSED: 'warn', CHANGES_REQUESTED: 'warn',
  FAILED: 'danger', REJECTED: 'danger', EXPIRED: 'danger', PARKED: 'danger', CANCELLED: 'danger',
  CRITICAL: 'danger', HIGH: 'danger', MEDIUM: 'warn', LOW: 'muted',
  MUST: 'danger', SHOULD: 'warn', COULD: 'muted', WONT: 'muted',
};

export function Badge({ children, tone = 'muted' }: { children: ReactNode; tone?: Tone }) {
  return <span className={`badge ${tone}`}>{children}</span>;
}

export function Status({ value }: { value: string }) {
  return <Badge tone={TONES[value] ?? 'muted'}>{value.replace(/_/g, ' ').toLowerCase()}</Badge>;
}

export function Stat({ label, value, hint }: { label: string; value: ReactNode; hint?: string }) {
  return (
    <div className="card">
      <div className="stat-label">{label}</div>
      <div className="stat">{value}</div>
      {hint ? <div className="muted small">{hint}</div> : null}
    </div>
  );
}

export function Empty({ children }: { children: ReactNode }) {
  return <div className="empty">{children}</div>;
}

export function ErrorBanner({ error }: { error?: string | null }) {
  if (!error) return null;
  return <div className="banner danger">{error}</div>;
}

export function Section({ title, children, actions }: { title: string; children: ReactNode; actions?: ReactNode }) {
  return (
    <div className="card">
      <div className="spread" style={{ marginBottom: 10 }}>
        <h2 style={{ margin: 0 }}>{title}</h2>
        {actions}
      </div>
      {children}
    </div>
  );
}

export function money(usd: number | null | undefined): string {
  if (!usd) return '$0.00';
  return usd < 0.01 ? `$${usd.toFixed(4)}` : `$${usd.toFixed(2)}`;
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
