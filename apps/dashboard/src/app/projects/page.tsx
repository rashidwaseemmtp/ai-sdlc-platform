import { safeGet, type ProjectSummary } from '@/lib/api';
import { Empty, ErrorBanner, StatusBadge } from '@/components/ui';

export const dynamic = 'force-dynamic';

export default async function Projects() {
  const { data, error } = await safeGet<ProjectSummary[]>('/projects', []);
  return (
    <>
      <h1>Projects</h1>
      <p className="lede">Each project has its own models, repositories, MCP servers and approval rules.</p>
      <ErrorBanner error={error} />
      {data.length === 0 ? (
        <Empty>No projects. Run <code className="mono">pnpm db:seed</code> for the demo project.</Empty>
      ) : (
        <div className="card table-wrap">
          <table>
            <thead><tr><th>Key</th><th>Name</th><th>Phase</th><th>Requirements</th><th>Stories</th><th>Repositories</th></tr></thead>
            <tbody>
              {data.map((p) => (
                <tr key={p.id}>
                  <td className="mono"><a href={`/projects/${p.key}`}>{p.key}</a></td>
                  <td>{p.name}</td>
                  <td><StatusBadge status={p.phase} /></td>
                  <td>{p._count.requirements}</td>
                  <td>{p._count.stories}</td>
                  <td className="muted small mono">{p.repositories.map((r) => r.key).join(', ') || '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}
