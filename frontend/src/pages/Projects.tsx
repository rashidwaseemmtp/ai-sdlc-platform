import { useState } from 'react';
import { Link } from 'react-router-dom';
import { post, useApi } from '../api';
import { Empty, ErrorBanner, Status, when } from '../ui';

interface ProjectRow {
  id: string;
  key: string;
  name: string;
  description: string | null;
  phase: string;
  createdAt: string;
  run: { stage: string; status: string; spendUsd: number } | null;
  _count: { requirements: number; stories: number; documents: number; agentRuns: number };
}

export function Projects() {
  const { data, error, loading, reload } = useApi<ProjectRow[]>('/projects', 5000);
  const [creating, setCreating] = useState(false);
  const [form, setForm] = useState({ key: '', name: '', description: '' });
  const [formError, setFormError] = useState<string | null>(null);

  async function create(event: React.FormEvent) {
    event.preventDefault();
    setFormError(null);
    try {
      await post('/projects', form);
      setForm({ key: '', name: '', description: '' });
      setCreating(false);
      await reload();
    } catch (caught) {
      setFormError((caught as Error).message);
    }
  }

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Projects</h1>
          <div className="muted small">Each project runs the five-stage pipeline independently.</div>
        </div>
        <button className="primary" onClick={() => setCreating((open) => !open)}>
          {creating ? 'Cancel' : 'New project'}
        </button>
      </div>

      <ErrorBanner error={error} />

      {creating ? (
        <form className="card" onSubmit={create}>
          <ErrorBanner error={formError} />
          <div className="grid">
            <label>
              <span>Key</span>
              <input
                value={form.key}
                onChange={(event) => setForm({ ...form, key: event.target.value })}
                placeholder="CMS"
                required
              />
              <div className="field-hint">Short, unique, used in URLs.</div>
            </label>
            <label>
              <span>Name</span>
              <input
                value={form.name}
                onChange={(event) => setForm({ ...form, name: event.target.value })}
                placeholder="Customer Management SaaS"
                required
              />
            </label>
          </div>
          <label>
            <span>Description</span>
            <input
              value={form.description}
              onChange={(event) => setForm({ ...form, description: event.target.value })}
              placeholder="What this project is for"
            />
          </label>
          <button className="primary" type="submit">Create</button>
        </form>
      ) : null}

      <div className="card table-card">
        {loading && !data ? (
          <Empty>Loading…</Empty>
        ) : !data?.length ? (
          <Empty>No projects yet. Create one, add the client material, and press Start.</Empty>
        ) : (
          <table>
            <thead>
              <tr>
                <th>Project</th>
                <th>Phase</th>
                <th>Stage</th>
                <th>Docs</th>
                <th>Reqs</th>
                <th>Stories</th>
                <th>Spend</th>
                <th>Created</th>
              </tr>
            </thead>
            <tbody>
              {data.map((project) => (
                <tr key={project.id}>
                  <td>
                    <Link to={`/projects/${project.key}`}>
                      <strong>{project.key}</strong>
                    </Link>
                    <div className="muted small">{project.name}</div>
                  </td>
                  <td><Status value={project.phase} /></td>
                  <td>
                    {project.run ? (
                      <>
                        <div className="small">{project.run.stage}</div>
                        <Status value={project.run.status} />
                      </>
                    ) : (
                      <span className="muted small">not started</span>
                    )}
                  </td>
                  <td>{project._count.documents}</td>
                  <td>{project._count.requirements}</td>
                  <td>{project._count.stories}</td>
                  <td className="mono">${(project.run?.spendUsd ?? 0).toFixed(2)}</td>
                  <td className="muted small">{when(project.createdAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </>
  );
}
