import { Fragment, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { del, post, useApi } from '../api';
import { Empty, ErrorBanner, Stat, Status, when } from '../ui';
import { Code, Qa } from './ProjectDelivery';

interface Overview {
  project: {
    id: string;
    key: string;
    name: string;
    description: string | null;
    phase: string;
    run: {
      stage: string;
      status: string;
      iteration: number;
      completedStages: string[];
      spendUsd: number;
      parkedCode: string | null;
      parkedReason: string | null;
    } | null;
  };
  stages: { key: string; name: string }[];
  counts: {
    documents: number; requirements: number; stories: number; options: number;
    adrs: number; estimates: number; prs: number; testCases: number; bugs: number;
  };
  plan: { strategy: string; milestones: unknown; waves: unknown; criticalPathHours: number; resourcePlan: unknown } | null;
  approvals: { id: string; gate: string; title: string; status: string; requestedAt: string }[];
  cost: { runs: number; usd: number; tokens: number };
}

type Tab = 'documents' | 'requirements' | 'backlog' | 'architecture' | 'plan' | 'code' | 'qa' | 'timeline';

export function Project() {
  const { key = '' } = useParams();
  const { data, error, reload } = useApi<Overview>(`/projects/${key}`, 4000);
  const [tab, setTab] = useState<Tab>('documents');
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

  async function command(name: string) {
    setBusy(true);
    setActionError(null);
    try {
      await post(`/projects/${key}/${name}`);
      await reload();
    } catch (caught) {
      setActionError((caught as Error).message);
    } finally {
      setBusy(false);
    }
  }

  if (error) return <ErrorBanner error={error} />;
  if (!data) return <Empty>Loading…</Empty>;

  const { project, stages, counts, cost } = data;
  const run = project.run;
  const pending = data.approvals.find((approval) => approval.status === 'PENDING');

  return (
    <>
      <div className="page-head">
        <div>
          <h1>
            {project.key} · {project.name}
          </h1>
          <div className="muted small">{project.description ?? '—'}</div>
        </div>
        <div className="row">
          <Status value={project.phase} />
          {!run || ['COMPLETED', 'CANCELLED', 'PARKED'].includes(run.status) ? (
            <button className="primary" disabled={busy} onClick={() => void command('start')}>
              {run ? 'Restart pipeline' : 'Start pipeline'}
            </button>
          ) : null}
          {run?.status === 'PARKED' ? (
            <button disabled={busy} onClick={() => void command('resume')}>Resume</button>
          ) : null}
          {run && ['RUNNABLE', 'RUNNING'].includes(run.status) ? (
            <button disabled={busy} onClick={() => void command('pause')}>Pause</button>
          ) : null}
          {run?.status === 'PAUSED' ? (
            <button disabled={busy} onClick={() => void command('resume')}>Resume</button>
          ) : null}
          {run && !['COMPLETED', 'CANCELLED'].includes(run.status) ? (
            <button className="danger" disabled={busy} onClick={() => void command('cancel')}>Cancel</button>
          ) : null}
        </div>
      </div>

      <ErrorBanner error={actionError} />

      {run?.status === 'PARKED' ? (
        <div className="banner danger">
          <strong>Parked at {run.stage}</strong> — {run.parkedCode}: {run.parkedReason}
        </div>
      ) : null}

      {pending ? (
        <div className="banner warn">
          Waiting on you: <Link to={`/approvals/${pending.id}`}>{pending.title}</Link>
        </div>
      ) : null}

      <div className="card">
        <h3>Pipeline</h3>
        <div className="pipeline">
          {stages.map((stage) => {
            const done = run?.completedStages.includes(stage.key);
            const current = run?.stage === stage.key && run.status !== 'COMPLETED';
            return (
              <div key={stage.key} className={`step ${done ? 'done' : ''} ${current ? 'current' : ''}`}>
                {stage.name}
                <small>
                  {done ? 'done' : current ? `${run?.status.toLowerCase()}${run && run.iteration > 0 ? ` · round ${run.iteration + 1}` : ''}` : 'waiting'}
                </small>
              </div>
            );
          })}
        </div>
      </div>

      <div className="grid">
        <Stat label="Requirements" value={counts.requirements} />
        <Stat label="Stories" value={counts.stories} />
        <Stat label="Arch options" value={counts.options} hint={`${counts.adrs} ADR(s)`} />
        <Stat label="Estimates" value={counts.estimates} />
        <Stat label="Change sets" value={counts.prs} />
        <Stat label="Tests" value={counts.testCases} hint={counts.bugs ? counts.bugs + ' open bug(s)' : undefined} />
        <Stat label="Spend" value={`$${(run?.spendUsd ?? 0).toFixed(2)}`} hint={`${cost.runs} agent runs`} />
      </div>

      <div className="row" style={{ margin: '18px 0 12px' }}>
        {(['documents', 'requirements', 'backlog', 'architecture', 'plan', 'code', 'qa', 'timeline'] as Tab[]).map((name) => (
          <button key={name} className={tab === name ? 'primary' : ''} onClick={() => setTab(name)}>
            {name[0]!.toUpperCase() + name.slice(1)}
          </button>
        ))}
      </div>

      {tab === 'documents' ? <Documents projectKey={key} onChange={reload} /> : null}
      {tab === 'requirements' ? <Requirements projectKey={key} /> : null}
      {tab === 'backlog' ? <Backlog projectKey={key} /> : null}
      {tab === 'architecture' ? <Architecture projectKey={key} /> : null}
      {tab === 'plan' ? <Plan plan={data.plan} /> : null}
      {tab === 'code' ? <Code projectKey={key} /> : null}
      {tab === 'qa' ? <Qa projectKey={key} /> : null}
      {tab === 'timeline' ? <Timeline projectKey={key} /> : null}
    </>
  );
}

// ── Documents ──────────────────────────────────────────────────────────────

interface Doc { id: string; title: string; kind: string; content: string; createdAt: string }

function Documents({ projectKey, onChange }: { projectKey: string; onChange: () => void }) {
  const { data, reload } = useApi<Doc[]>(`/projects/${projectKey}/documents`);
  const [form, setForm] = useState({ title: '', kind: 'MEETING', content: '' });
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState<string | null>(null);

  async function add(event: React.FormEvent) {
    event.preventDefault();
    setError(null);
    try {
      await post(`/projects/${projectKey}/documents`, form);
      setForm({ title: '', kind: 'MEETING', content: '' });
      await reload();
      onChange();
    } catch (caught) {
      setError((caught as Error).message);
    }
  }

  return (
    <>
      <div className="card">
        <h2>Source material</h2>
        <div className="muted small" style={{ marginBottom: 10 }}>
          Everything the pipeline produces traces back to these. Paste transcripts, specifications
          or email threads exactly as they are — the Product Owner agent cites them by id.
        </div>
        <ErrorBanner error={error} />
        <form onSubmit={add}>
          <div className="grid">
            <label>
              <span>Title</span>
              <input value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} required />
            </label>
            <label>
              <span>Kind</span>
              <select value={form.kind} onChange={(e) => setForm({ ...form, kind: e.target.value })}>
                <option>MEETING</option>
                <option>SPEC</option>
                <option>EMAIL</option>
                <option>NOTE</option>
              </select>
            </label>
          </div>
          <label>
            <span>Content</span>
            <textarea value={form.content} onChange={(e) => setForm({ ...form, content: e.target.value })} required />
          </label>
          <button className="primary" type="submit">Add document</button>
        </form>
      </div>

      <div className="card table-card">
        {!data?.length ? (
          <Empty>No source documents yet.</Empty>
        ) : (
          <table>
            <thead>
              <tr><th>Title</th><th>Kind</th><th>Size</th><th>Added</th><th /></tr>
            </thead>
            <tbody>
              {data.map((doc) => (
                <Fragment key={doc.id}>
                  <tr>
                    <td>
                      <a href="#" onClick={(e) => { e.preventDefault(); setOpen(open === doc.id ? null : doc.id); }}>
                        {doc.title}
                      </a>
                      <div className="mono muted">{doc.id}</div>
                    </td>
                    <td><span className="badge muted">{doc.kind}</span></td>
                    <td className="muted small">{doc.content.length.toLocaleString()} chars</td>
                    <td className="muted small">{when(doc.createdAt)}</td>
                    <td>
                      <button className="danger" onClick={() => void del(`/projects/${projectKey}/documents/${doc.id}`).then(reload).then(onChange)}>
                        Delete
                      </button>
                    </td>
                  </tr>
                  {open === doc.id ? (
                    <tr>
                      <td colSpan={5}><div className="pre">{doc.content}</div></td>
                    </tr>
                  ) : null}
                </Fragment>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </>
  );
}

// ── Requirements ───────────────────────────────────────────────────────────

interface Requirement {
  id: string; ref: string; type: string; priority: string; statement: string;
  rationale: string | null; confidence: number; status: string; sourceRefs: string[];
}

function Requirements({ projectKey }: { projectKey: string }) {
  const { data } = useApi<Requirement[]>(`/projects/${projectKey}/requirements`, 6000);
  const discovery = useApi<{ productVision?: { statement: string; problem: string }; openQuestions?: { question: string; severity: string }[]; conflicts?: { leftRef: string; rightRef: string; nature: string }[] } | null>(
    `/projects/${projectKey}/discovery`,
  );

  return (
    <>
      {discovery.data?.productVision ? (
        <div className="card">
          <h3>Product vision</h3>
          <div>{discovery.data.productVision.statement}</div>
          <div className="muted small" style={{ marginTop: 6 }}>{discovery.data.productVision.problem}</div>
        </div>
      ) : null}

      {discovery.data?.conflicts?.length ? (
        <div className="banner warn">
          <strong>{discovery.data.conflicts.length} conflict(s) between sources</strong>
          <ul style={{ margin: '6px 0 0 18px' }}>
            {discovery.data.conflicts.map((conflict, index) => (
              <li key={index}>{conflict.leftRef} ↔ {conflict.rightRef}: {conflict.nature}</li>
            ))}
          </ul>
        </div>
      ) : null}

      <div className="card table-card">
        {!data?.length ? (
          <Empty>No requirements yet. They appear once discovery has run.</Empty>
        ) : (
          <table>
            <thead>
              <tr><th>Ref</th><th>Type</th><th>Priority</th><th>Statement</th><th>Confidence</th><th>Status</th></tr>
            </thead>
            <tbody>
              {data.map((requirement) => (
                <tr key={requirement.id}>
                  <td className="mono">{requirement.ref}</td>
                  <td className="small">{requirement.type.replace(/_/g, ' ').toLowerCase()}</td>
                  <td><Status value={requirement.priority} /></td>
                  <td>
                    {requirement.statement}
                    {requirement.rationale ? <div className="muted small">{requirement.rationale}</div> : null}
                  </td>
                  <td className="mono">{(requirement.confidence * 100).toFixed(0)}%</td>
                  <td><Status value={requirement.status} /></td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {discovery.data?.openQuestions?.length ? (
        <div className="card">
          <h3>Open questions</h3>
          <ul style={{ margin: 0, paddingLeft: 18 }}>
            {discovery.data.openQuestions.map((question, index) => (
              <li key={index}>
                {question.question} <Status value={question.severity} />
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </>
  );
}

// ── Backlog ────────────────────────────────────────────────────────────────

interface Story {
  id: string; ref: string; title: string; userStory: string; priority: string; sizeSignal: string;
  status: string; acceptanceCriteria: { kind: string; given?: string; when?: string; then?: string; statement?: string }[];
  edgeCases: string[]; requirementRefs: string[]; dependsOn: string[];
  qualityFlags: { kind: string; detail: string; severity: string; source?: string }[];
  estimates: { estimatorKind: string; hours: number; confidence: number; riskLevel: string }[];
}

function Backlog({ projectKey }: { projectKey: string }) {
  const { data } = useApi<Story[]>(`/projects/${projectKey}/stories`, 6000);
  const [open, setOpen] = useState<string | null>(null);

  if (!data?.length) return <div className="card"><Empty>No stories yet.</Empty></div>;

  return (
    <div className="card table-card">
      <table>
        <thead>
          <tr><th>Ref</th><th>Story</th><th>Priority</th><th>Size</th><th>Flags</th><th>Estimates</th><th>Status</th></tr>
        </thead>
        <tbody>
          {data.map((story) => (
            <Fragment key={story.id}>
              <tr>
                <td className="mono">{story.ref}</td>
                <td>
                  <a href="#" onClick={(e) => { e.preventDefault(); setOpen(open === story.id ? null : story.id); }}>
                    {story.title}
                  </a>
                  <div className="muted small">{story.userStory}</div>
                </td>
                <td><Status value={story.priority} /></td>
                <td className="mono">{story.sizeSignal}</td>
                <td>
                  {story.qualityFlags.length ? (
                    <Status value={story.qualityFlags.some((f) => f.severity === 'CRITICAL' || f.severity === 'HIGH') ? 'HIGH' : 'MEDIUM'} />
                  ) : (
                    <span className="muted small">—</span>
                  )}
                </td>
                <td className="mono small">
                  {story.estimates.length
                    ? story.estimates.map((estimate) => `${estimate.estimatorKind[0]}:${estimate.hours}h`).join(' · ')
                    : '—'}
                </td>
                <td><Status value={story.status} /></td>
              </tr>
              {open === story.id ? (
                <tr>
                  <td colSpan={7}>
                    <h3>Acceptance criteria</h3>
                    <ul style={{ margin: '0 0 10px 18px' }}>
                      {story.acceptanceCriteria.map((criterion, index) => (
                        <li key={index}>
                          {criterion.kind === 'GWT'
                            ? `Given ${criterion.given} · When ${criterion.when} · Then ${criterion.then}`
                            : criterion.statement}
                        </li>
                      ))}
                    </ul>
                    <h3>Edge cases</h3>
                    <ul style={{ margin: '0 0 10px 18px' }}>
                      {story.edgeCases.map((edge, index) => <li key={index}>{edge}</li>)}
                    </ul>
                    <div className="row small">
                      <span className="muted">Traces to:</span>
                      {story.requirementRefs.map((ref) => <span key={ref} className="badge muted">{ref}</span>)}
                      {story.dependsOn.length ? <span className="muted">Blocked by:</span> : null}
                      {story.dependsOn.map((ref) => <span key={ref} className="badge warn">{ref}</span>)}
                    </div>
                    {story.qualityFlags.length ? (
                      <>
                        <h3 style={{ marginTop: 12 }}>Quality flags</h3>
                        <ul style={{ margin: '0 0 0 18px' }}>
                          {story.qualityFlags.map((flag, index) => (
                            <li key={index}>
                              <Status value={flag.severity} /> <strong>{flag.kind}</strong> — {flag.detail}
                              {flag.source === 'platform' ? <span className="badge info"> found by the platform</span> : null}
                            </li>
                          ))}
                        </ul>
                      </>
                    ) : null}
                  </td>
                </tr>
              ) : null}
            </Fragment>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// ── Architecture ───────────────────────────────────────────────────────────

interface ArchitectureData {
  options: {
    id: string; round: number; variant: string; name: string; overview: string;
    detail: Record<string, unknown>;
    evaluations: { criterion: string; score: number; reasoning: string }[];
  }[];
  adrs: { id: string; number: number; title: string; decision: string; rationale: string; consequences: string[]; alternatives: string[]; approvedBy: string | null }[];
}

function Architecture({ projectKey }: { projectKey: string }) {
  const { data } = useApi<ArchitectureData>(`/projects/${projectKey}/architecture`, 6000);
  const [open, setOpen] = useState<string | null>(null);

  if (!data?.options.length) return <div className="card"><Empty>No architecture options yet.</Empty></div>;

  return (
    <>
      {data.adrs.map((adr) => (
        <div className="card" key={adr.id}>
          <h2>ADR-{String(adr.number).padStart(3, '0')} · {adr.title}</h2>
          <p>{adr.decision}</p>
          <div className="muted small">{adr.rationale}</div>
          <h3 style={{ marginTop: 10 }}>Consequences accepted</h3>
          <ul style={{ margin: '0 0 10px 18px' }}>{adr.consequences.map((item, index) => <li key={index}>{item}</li>)}</ul>
          <div className="muted small">Rejected: {adr.alternatives.join(' · ')} — approved by {adr.approvedBy ?? '—'}</div>
        </div>
      ))}

      {data.options.map((option) => {
        const mean = option.evaluations.length
          ? option.evaluations.reduce((sum, item) => sum + item.score, 0) / option.evaluations.length
          : null;
        return (
          <div className="card" key={option.id}>
            <div className="spread">
              <h2 style={{ margin: 0 }}>
                Option {option.variant} · {option.name} <span className="muted small">round {option.round}</span>
              </h2>
              <div className="row">
                {mean !== null ? <span className="badge info">mean {mean.toFixed(1)}/10</span> : null}
                <button onClick={() => setOpen(open === option.id ? null : option.id)}>
                  {open === option.id ? 'Hide detail' : 'Show detail'}
                </button>
              </div>
            </div>
            <p className="small">{option.overview}</p>
            {option.evaluations.length ? (
              <div className="row small">
                {option.evaluations.map((evaluation) => (
                  <span key={evaluation.criterion} className="badge muted" title={evaluation.reasoning}>
                    {evaluation.criterion.replace(/_/g, ' ').toLowerCase()} {evaluation.score}
                  </span>
                ))}
              </div>
            ) : null}
            {open === option.id ? <div className="pre" style={{ marginTop: 10 }}>{JSON.stringify(option.detail, null, 2)}</div> : null}
          </div>
        );
      })}
    </>
  );
}

// ── Plan ───────────────────────────────────────────────────────────────────

function Plan({ plan }: { plan: Overview['plan'] }) {
  if (!plan) return <div className="card"><Empty>No delivery plan yet.</Empty></div>;

  const waves = (plan.waves ?? []) as { index: number; refs: string[] }[];
  const milestones = (plan.milestones ?? []) as { name: string; goal: string; storyRefs: string[] }[];

  return (
    <>
      <div className="card">
        <h2>Strategy</h2>
        <p>{plan.strategy || '—'}</p>
        <div className="muted small">Critical path: {plan.criticalPathHours}h</div>
      </div>

      <div className="card">
        <h2>Dependency waves</h2>
        <div className="muted small" style={{ marginBottom: 8 }}>
          Computed from the stories' own dependencies, not from the planner's answer.
        </div>
        {waves.map((wave) => (
          <div key={wave.index} className="row" style={{ marginBottom: 6 }}>
            <strong className="small">Wave {wave.index + 1}</strong>
            {wave.refs.map((ref) => <span key={ref} className="badge muted">{ref}</span>)}
          </div>
        ))}
      </div>

      <div className="card">
        <h2>Milestones</h2>
        {milestones.map((milestone, index) => (
          <div key={index} style={{ marginBottom: 10 }}>
            <strong>{milestone.name}</strong> <span className="muted small">{milestone.goal}</span>
            <div className="row" style={{ marginTop: 4 }}>
              {milestone.storyRefs.map((ref) => <span key={ref} className="badge muted">{ref}</span>)}
            </div>
          </div>
        ))}
      </div>

      <div className="card">
        <h2>Staffing</h2>
        <div className="pre">{JSON.stringify(plan.resourcePlan, null, 2)}</div>
      </div>
    </>
  );
}

// ── Timeline ───────────────────────────────────────────────────────────────

function Timeline({ projectKey }: { projectKey: string }) {
  const { data } = useApi<{ id: string; type: string; actor: string; payload: unknown; createdAt: string }[]>(
    `/projects/${projectKey}/events`,
    5000,
  );

  if (!data?.length) return <div className="card"><Empty>Nothing has happened yet.</Empty></div>;

  return (
    <div className="card table-card">
      <table>
        <thead><tr><th>When</th><th>Event</th><th>Actor</th><th>Detail</th></tr></thead>
        <tbody>
          {data.map((event) => (
            <tr key={event.id}>
              <td className="muted small">{when(event.createdAt)}</td>
              <td className="mono small">{event.type}</td>
              <td className="muted small">{event.actor}</td>
              <td className="mono small">{JSON.stringify(event.payload)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
