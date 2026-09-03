import {
  safeGet,
  type ArchitectureBundle,
  type CostRollup,
  type Pipeline,
  type ProjectSummary,
  type Story,
} from '@/lib/api';
import { Badge, Empty, ErrorBanner, Stat, StatusBadge } from '@/components/ui';

export const dynamic = 'force-dynamic';

interface QaBundle {
  testCases: { ref: string; title: string; type: string; automationStatus: string; story: { ref: string } | null }[];
  runs: {
    id: string;
    status: string;
    startedAt: string;
    results: { status: string; testCase: { ref: string }; evidence: { kind: string }[] }[];
  }[];
  bugs: { ref: string; title: string; severity: string; status: string }[];
}

interface PrRow {
  id: string;
  number: number | null;
  title: string;
  state: string;
  url: string | null;
  branchName: string;
  story: { ref: string; title: string } | null;
  reviews: { reviewerKind: string; verdict: string; summary: string; comments: { severity: string; body: string; path: string | null }[] }[];
}

export default async function ProjectPage({ params }: { params: Promise<{ key: string }> }) {
  const { key } = await params;

  const [project, pipeline, stories, architecture, prs, qa, cost] = await Promise.all([
    safeGet<ProjectSummary | null>(`/projects/${key}`, null),
    safeGet<Pipeline | null>(`/projects/${key}/pipeline`, null),
    safeGet<Story[]>(`/projects/${key}/stories`, []),
    safeGet<ArchitectureBundle | null>(`/projects/${key}/architecture`, null),
    safeGet<PrRow[]>(`/projects/${key}/pull-requests`, []),
    safeGet<QaBundle | null>(`/projects/${key}/qa`, null),
    safeGet<CostRollup | null>(`/projects/${key}/cost`, null),
  ]);

  if (!project.data) {
    return (
      <>
        <h1>Project {key}</h1>
        <ErrorBanner error={project.error ?? 'not found'} />
      </>
    );
  }

  const results = qa.data?.runs.flatMap((run) => run.results) ?? [];
  const passed = results.filter((r) => r.status === 'PASS').length;

  return (
    <>
      <div className="row" style={{ justifyContent: 'space-between' }}>
        <div>
          <h1>
            <span className="mono muted">{project.data.key}</span> {project.data.name}
          </h1>
          <p className="lede">{project.data.description}</p>
        </div>
        <StatusBadge status={project.data.phase} />
      </div>

      {/* The doc-52 pipeline: one glance tells you where the project actually is. */}
      {pipeline.data ? (
        <div className="pipeline">
          {pipeline.data.stages.map((stage) => (
            <div key={stage.name} className={`stage ${stage.state.toLowerCase()}`}>
              <div className="stage-name">{stage.name}</div>
              <div className="stage-detail">{stage.detail || '—'}</div>
            </div>
          ))}
        </div>
      ) : null}

      {pipeline.data?.pendingApprovals.length ? (
        <div className="banner warn" style={{ marginTop: 16 }}>
          <strong>{pipeline.data.pendingApprovals.length} decision(s) waiting.</strong>{' '}
          {pipeline.data.pendingApprovals.map((approval) => (
            <a key={approval.id} href={`/approvals/${approval.id}`} style={{ marginRight: 12 }}>
              {approval.title}
            </a>
          ))}
        </div>
      ) : null}

      <div className="grid cols-4" style={{ marginTop: 18 }}>
        <Stat label="Requirements" value={project.data._count.requirements} />
        <Stat label="Stories" value={stories.data.length} />
        <Stat label="Pull requests" value={prs.data.length} />
        <Stat
          label="Spend"
          value={`$${(cost.data?.total.costUsd ?? 0).toFixed(2)}`}
          hint={`budget $${cost.data?.budgetUsd ?? 0} · ${(cost.data?.total.tokens ?? 0).toLocaleString()} tokens`}
        />
      </div>

      {/* ── Backlog ─────────────────────────────────────────────────── */}
      <h2>Backlog</h2>
      <ErrorBanner error={stories.error} />
      {stories.data.length === 0 ? (
        <Empty>No stories yet.</Empty>
      ) : (
        <div className="grid">
          {stories.data.map((story) => {
            const estimate = story.estimates.find((e) => e.estimatorKind === 'PRIMARY');
            return (
              <div className="card" key={story.id}>
                <div className="row" style={{ justifyContent: 'space-between' }}>
                  <strong>
                    <span className="mono muted">{story.ref}</span> {story.title}
                  </strong>
                  <div className="row">
                    <Badge tone="muted">{story.priority}</Badge>
                    <Badge tone="muted">{story.sizeSignal}</Badge>
                    <StatusBadge status={story.status} />
                  </div>
                </div>
                <div className="small muted" style={{ marginTop: 6 }}>{story.userStory}</div>

                <div style={{ marginTop: 12 }}>
                  <div className="stat-label">Acceptance criteria</div>
                  <ul className="small" style={{ margin: '6px 0 0', paddingLeft: 18 }}>
                    {story.acceptanceCriteria.map((criterion) => (
                      <li key={criterion.ref}>
                        {criterion.kind === 'GWT' ? (
                          <>
                            <em>Given</em> {criterion.given} <em>when</em> {criterion.whenText}{' '}
                            <em>then</em> {criterion.thenText}
                          </>
                        ) : (
                          criterion.statement
                        )}
                      </li>
                    ))}
                  </ul>
                </div>

                <div className="row small muted" style={{ marginTop: 12 }}>
                  <span>
                    traces to{' '}
                    <span className="mono">
                      {story.requirementLinks.map((l) => l.requirement.ref).join(', ') || 'nothing'}
                    </span>
                  </span>
                  {estimate ? (
                    <span>
                      · {estimate.hoursEngineering}h ({estimate.rangeLowHours}–{estimate.rangeHighHours}h,
                      confidence {(estimate.confidence * 100).toFixed(0)}%)
                    </span>
                  ) : null}
                </div>

                {story.qualityFlags.length ? (
                  <div style={{ marginTop: 10 }}>
                    {story.qualityFlags.map((flag, index) => (
                      <div key={index} className="small">
                        <StatusBadge status={flag.severity} />{' '}
                        <span className="mono">{flag.kind}</span> — {flag.detail}
                      </div>
                    ))}
                  </div>
                ) : null}
              </div>
            );
          })}
        </div>
      )}

      {/* ── Architecture ────────────────────────────────────────────── */}
      <h2>Architecture</h2>
      {!architecture.data?.options.length ? (
        <Empty>No architecture options yet.</Empty>
      ) : (
        <>
          <div className="grid cols-3">
            {architecture.data.options.map((option) => {
              const mean =
                option.evaluations.length > 0
                  ? option.evaluations.reduce((sum, e) => sum + e.score, 0) / option.evaluations.length
                  : 0;
              const chosen = architecture.data?.recommendation?.recommendedOptionId === option.id;
              return (
                <div className="card" key={option.id}>
                  <div className="row" style={{ justifyContent: 'space-between' }}>
                    <strong>Option {option.variant}</strong>
                    {chosen ? <Badge tone="ok">recommended</Badge> : null}
                  </div>
                  <div style={{ marginTop: 4 }}>{option.name}</div>
                  <div className="stat" style={{ marginTop: 8 }}>{mean.toFixed(1)}<span className="muted small">/10</span></div>
                  <div className="muted small">
                    dev {option.developmentComplexity} · ops {option.operationalComplexity}
                  </div>
                  <div style={{ marginTop: 10 }}>
                    <div className="stat-label">Disadvantages</div>
                    <ul className="small" style={{ margin: '4px 0 0', paddingLeft: 18 }}>
                      {option.disadvantages.slice(0, 3).map((item) => (
                        <li key={item}>{item}</li>
                      ))}
                    </ul>
                  </div>
                </div>
              );
            })}
          </div>

          {architecture.data.recommendation ? (
            <div className="card" style={{ marginTop: 14 }}>
              <div className="stat-label">Critic recommendation</div>
              <p className="small" style={{ marginBottom: 0 }}>
                {architecture.data.recommendation.reasoning}
              </p>
            </div>
          ) : null}

          {architecture.data.adrs.map((adr) => (
            <div className="card" key={adr.number} style={{ marginTop: 14 }}>
              <div className="row" style={{ justifyContent: 'space-between' }}>
                <strong>ADR-{String(adr.number).padStart(3, '0')} — {adr.title}</strong>
                <StatusBadge status={adr.status} />
              </div>
              <p className="small" style={{ marginBottom: 4 }}>{adr.decision}</p>
              <p className="small muted" style={{ margin: 0 }}>{adr.rationale}</p>
            </div>
          ))}
        </>
      )}

      {/* ── Pull requests ───────────────────────────────────────────── */}
      <h2>Pull requests</h2>
      {prs.data.length === 0 ? (
        <Empty>No pull requests yet.</Empty>
      ) : (
        <div className="grid">
          {prs.data.map((pr) => (
            <div className="card" key={pr.id}>
              <div className="row" style={{ justifyContent: 'space-between' }}>
                <strong>
                  <span className="mono muted">#{pr.number ?? '?'}</span> {pr.title}
                </strong>
                <StatusBadge status={pr.state} />
              </div>
              <div className="muted small mono" style={{ marginTop: 4 }}>{pr.branchName}</div>
              {pr.reviews.map((review, index) => (
                <div key={index} className="small" style={{ marginTop: 8 }}>
                  <Badge tone={review.verdict === 'APPROVE' ? 'ok' : 'warn'}>
                    {review.reviewerKind} · {review.verdict}
                  </Badge>{' '}
                  {review.summary}
                  {review.comments.length ? (
                    <ul style={{ margin: '4px 0 0', paddingLeft: 18 }}>
                      {review.comments.map((comment, i) => (
                        <li key={i}>
                          <StatusBadge status={comment.severity} />{' '}
                          <span className="mono">{comment.path}</span> {comment.body}
                        </li>
                      ))}
                    </ul>
                  ) : null}
                </div>
              ))}
            </div>
          ))}
        </div>
      )}

      {/* ── QA ──────────────────────────────────────────────────────── */}
      <h2>Quality</h2>
      {!qa.data?.testCases.length ? (
        <Empty>No test cases yet.</Empty>
      ) : (
        <>
          <div className="grid cols-4">
            <Stat label="Test cases" value={qa.data.testCases.length} />
            <Stat label="Executed" value={results.length} />
            <Stat label="Passed" value={passed} hint={`${results.length - passed} failed`} />
            <Stat label="Open bugs" value={qa.data.bugs.filter((b) => b.status !== 'VERIFIED').length} />
          </div>

          <div className="card table-wrap" style={{ marginTop: 14 }}>
            <table>
              <thead>
                <tr><th>Ref</th><th>Story</th><th>Title</th><th>Type</th><th>Automation</th></tr>
              </thead>
              <tbody>
                {qa.data.testCases.slice(0, 30).map((testCase) => (
                  <tr key={testCase.ref}>
                    <td className="mono">{testCase.ref}</td>
                    <td className="mono muted">{testCase.story?.ref ?? '—'}</td>
                    <td>{testCase.title}</td>
                    <td className="muted small">{testCase.type}</td>
                    <td><Badge tone={testCase.automationStatus === 'AUTOMATED' ? 'ok' : 'muted'}>{testCase.automationStatus.toLowerCase()}</Badge></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {qa.data.bugs.length ? (
            <div className="card" style={{ marginTop: 14 }}>
              <div className="stat-label">Bugs</div>
              {qa.data.bugs.map((bug) => (
                <div key={bug.ref} className="small" style={{ marginTop: 6 }}>
                  <span className="mono">{bug.ref}</span> <StatusBadge status={bug.severity} />{' '}
                  <StatusBadge status={bug.status} /> {bug.title}
                </div>
              ))}
            </div>
          ) : null}
        </>
      )}

      {/* ── Cost ────────────────────────────────────────────────────── */}
      <h2>Cost</h2>
      {!cost.data?.rows.length ? (
        <Empty>No spend recorded.</Empty>
      ) : (
        <div className="card table-wrap">
          <table>
            <thead>
              <tr><th>Agent</th><th>Runs</th><th>Tokens</th><th>Cost</th><th>Quota</th></tr>
            </thead>
            <tbody>
              {cost.data.rows.map((row) => (
                <tr key={row.agentKey}>
                  <td className="mono">{row.agentKey}</td>
                  <td>{row.runs}</td>
                  <td>{row.tokens.toLocaleString()}</td>
                  <td>{row.costUnknown ? <span className="muted">unknown</span> : `$${row.costUsd.toFixed(4)}`}</td>
                  <td className="muted">{row.quotaUnits || '—'}</td>
                </tr>
              ))}
              <tr>
                <td><strong>Total</strong></td>
                <td><strong>{cost.data.total.runs}</strong></td>
                <td><strong>{cost.data.total.tokens.toLocaleString()}</strong></td>
                <td><strong>${cost.data.total.costUsd.toFixed(4)}</strong></td>
                <td><strong>{cost.data.total.quotaUnits || '—'}</strong></td>
              </tr>
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}
