import { safeGet, type ApprovalListItem, type AgentRunRow, type Health, type ProjectSummary } from '@/lib/api';
import { Badge, Empty, ErrorBanner, Stat, StatusBadge, duration, when } from '@/components/ui';

export const dynamic = 'force-dynamic';

export default async function Dashboard() {
  const [projects, approvals, runs, health] = await Promise.all([
    safeGet<ProjectSummary[]>('/projects', []),
    safeGet<ApprovalListItem[]>('/approvals?status=PENDING', []),
    safeGet<AgentRunRow[]>('/agent-runs?limit=12', []),
    safeGet<Health | null>('/health', null).then(async () => {
      try {
        const response = await fetch(`${process.env.API_BASE ?? 'http://localhost:3001/api/v1'}/health`, {
          cache: 'no-store',
        });
        return { data: (await response.json()) as Health };
      } catch (error) {
        return { data: null, error: (error as Error).message };
      }
    }),
  ]);

  const failing = runs.data.filter((run) => run.status !== 'SUCCEEDED' && run.status !== 'RUNNING');
  const interventions = approvals.data.filter((approval) => approval.isIntervention);

  return (
    <>
      <h1>Dashboard</h1>
      <p className="lede">What the organization is doing right now.</p>

      {health.data ? (
        <>
          {health.data.demoMode ? (
            <div className="banner info">
              <strong>Demo mode.</strong> Model, GitHub, Figma and Playwright calls are served by
              mock providers. No credentials are in use and nothing leaves this machine.
            </div>
          ) : null}
          {health.data.aiMergePermission ? (
            <div className="banner danger">
              <strong>AI merge is enabled.</strong> Agents can merge pull requests on this
              installation. This is off by default for a reason.
            </div>
          ) : null}
          {health.data.temporal !== 'up' ? (
            <div className="banner warn">
              Temporal is unreachable. Existing data is readable, but no workflow can start or
              resume until it returns.
            </div>
          ) : null}
        </>
      ) : (
        <div className="banner danger">The API is unreachable. Start it with <code>pnpm api:dev</code>.</div>
      )}

      <div className="grid cols-4">
        <Stat label="Projects" value={projects.data.length} />
        <Stat
          label="Awaiting a human"
          value={approvals.data.length}
          hint={interventions.length ? `${interventions.length} intervention(s)` : undefined}
        />
        <Stat label="Recent agent runs" value={runs.data.length} />
        <Stat
          label="Failing runs"
          value={failing.length}
          hint={failing.length ? failing[0]?.error?.code : 'all healthy'}
        />
      </div>

      <h2>Waiting on you</h2>
      <ErrorBanner error={approvals.error} />
      {approvals.data.length === 0 ? (
        <Empty>Nothing is waiting for a decision.</Empty>
      ) : (
        <div className="card table-wrap">
          <table>
            <thead>
              <tr>
                <th>Gate</th>
                <th>Project</th>
                <th>Title</th>
                <th>Role</th>
                <th>Waiting</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {approvals.data.map((approval) => (
                <tr key={approval.id}>
                  <td>
                    {approval.isIntervention ? (
                      <Badge tone="danger">intervention</Badge>
                    ) : (
                      <Badge tone="warn">{approval.gate.toLowerCase()}</Badge>
                    )}
                  </td>
                  <td className="mono">{approval.project.key}</td>
                  <td>{approval.title}</td>
                  <td className="muted small">{approval.requiredRole}</td>
                  <td className="muted small">{when(approval.requestedAt)}</td>
                  <td>
                    <a className="btn" href={`/approvals/${approval.id}`}>
                      Review
                    </a>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <h2>Projects</h2>
      <ErrorBanner error={projects.error} />
      {projects.data.length === 0 ? (
        <Empty>
          No projects yet. Seed the demo with <code className="mono">pnpm db:seed</code>.
        </Empty>
      ) : (
        <div className="grid cols-2">
          {projects.data.map((project) => (
            <a key={project.id} className="card" href={`/projects/${project.key}`} style={{ color: 'inherit' }}>
              <div className="row" style={{ justifyContent: 'space-between' }}>
                <strong>
                  <span className="mono muted">{project.key}</span> {project.name}
                </strong>
                <StatusBadge status={project.phase} />
              </div>
              <div className="muted small" style={{ marginTop: 6 }}>
                {project.description ?? 'No description'}
              </div>
              <div className="muted small" style={{ marginTop: 8 }}>
                {project._count.requirements} requirements · {project._count.stories} stories ·{' '}
                {project.repositories.length} repo(s)
              </div>
            </a>
          ))}
        </div>
      )}

      <h2>Recent agent activity</h2>
      <ErrorBanner error={runs.error} />
      {runs.data.length === 0 ? (
        <Empty>No agent has run yet.</Empty>
      ) : (
        <div className="card table-wrap">
          <table>
            <thead>
              <tr>
                <th>Agent</th>
                <th>Phase</th>
                <th>Status</th>
                <th>Duration</th>
                <th>Tokens</th>
                <th>Cost</th>
                <th>When</th>
              </tr>
            </thead>
            <tbody>
              {runs.data.map((run) => (
                <tr key={run.id}>
                  <td>
                    <a href={`/runs/${run.id}`} className="mono">
                      {run.agentKey}
                    </a>
                  </td>
                  <td className="muted small">{run.phase ?? '—'}</td>
                  <td>
                    <StatusBadge status={run.status} />
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
