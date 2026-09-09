/** The delivery half of a project page: what the developer wrote, and what QA found. */

import { Fragment, useState } from 'react';
import { useApi } from '../api';
import { Empty, Status, when } from '../ui';

interface Finding {
  path: string;
  line?: number;
  severity: string;
  category: string;
  body: string;
  suggestion: string;
}

interface ReviewRound {
  round: number;
  verdict: string;
  code: { verdict: string; summary: string; findings: Finding[] };
  security: { verdict: string; summary: string; findings: Finding[] };
}

interface PullRequest {
  id: string;
  branch: string;
  title: string;
  summary: string;
  status: string;
  number: number | null;
  url: string | null;
  files: string[];
  diff: string;
  reviews: ReviewRound[];
  fixRounds: number;
  createdAt: string;
  story: { ref: string; title: string; status: string };
}

export function Code({ projectKey }: { projectKey: string }) {
  const { data } = useApi<PullRequest[]>(`/projects/${projectKey}/code`, 6000);
  const [open, setOpen] = useState<string | null>(null);
  const [tab, setTab] = useState<'diff' | 'reviews'>('diff');

  if (!data?.length) {
    return (
      <div className="card">
        <Empty>
          No code yet. The developer runs once the delivery plan is approved.
        </Empty>
      </div>
    );
  }

  return (
    <>
      <div className="card">
        <div className="muted small">
          The developer writes into a git repository the backend owns; each story gets a branch. With
          a GitHub token configured, the platform also pushes the branch and opens a real pull
          request — it never merges one, and no agent is given a tool that could.
        </div>
      </div>

      {data.map((pr) => {
        const last = pr.reviews.at(-1);
        return (
          <div className="card" key={pr.id}>
            <div className="spread">
              <div>
                <strong>{pr.story.ref}</strong> · {pr.title}
                <div className="muted small">
                  <span className="mono">{pr.branch}</span> · {pr.files.length} file(s) ·{' '}
                  {pr.fixRounds > 0 ? `${pr.fixRounds} fix round(s) · ` : ''}
                  {when(pr.createdAt)}
                </div>
              </div>
              <div className="row">
                <Status value={pr.story.status} />
                {last ? (
                  <span
                    className={`badge ${
                      last.verdict === 'APPROVE' ? 'ok' : last.verdict === 'REJECT' ? 'danger' : 'warn'
                    }`}
                  >
                    {last.verdict.replace(/_/g, ' ').toLowerCase()}
                  </span>
                ) : null}
                {pr.url ? (
                  <a className="badge info" href={pr.url} target="_blank" rel="noreferrer">
                    PR #{pr.number}
                  </a>
                ) : (
                  <span className="badge muted">{pr.status.toLowerCase()}</span>
                )}
                <button onClick={() => setOpen(open === pr.id ? null : pr.id)}>
                  {open === pr.id ? 'Hide' : 'Open'}
                </button>
              </div>
            </div>

            <p className="small" style={{ marginBottom: 4 }}>{pr.summary}</p>

            {open === pr.id ? (
              <>
                <div className="row" style={{ margin: '10px 0' }}>
                  <button className={tab === 'diff' ? 'primary' : ''} onClick={() => setTab('diff')}>
                    Diff
                  </button>
                  <button className={tab === 'reviews' ? 'primary' : ''} onClick={() => setTab('reviews')}>
                    Reviews ({pr.reviews.length})
                  </button>
                </div>

                {tab === 'diff' ? (
                  <>
                    <div className="row small" style={{ marginBottom: 6 }}>
                      {pr.files.map((file) => (
                        <span key={file} className="badge muted mono">
                          {file}
                        </span>
                      ))}
                    </div>
                    <div className="pre">{pr.diff || 'No diff recorded.'}</div>
                  </>
                ) : (
                  pr.reviews.map((round) => (
                    <div key={round.round} style={{ marginBottom: 12 }}>
                      <h3>
                        Round {round.round} — {round.verdict.replace(/_/g, ' ').toLowerCase()}
                      </h3>
                      {(['code', 'security'] as const).map((which) => (
                        <div key={which} style={{ marginBottom: 8 }}>
                          <div className="small">
                            <strong>{which === 'code' ? 'Code reviewer' : 'Security reviewer'}</strong>{' '}
                            <Status value={round[which].verdict} /> {round[which].summary}
                          </div>
                          {round[which].findings.length ? (
                            <table>
                              <tbody>
                                {round[which].findings.map((finding, index) => (
                                  <tr key={index}>
                                    <td style={{ width: 80 }}>
                                      <Status value={finding.severity} />
                                    </td>
                                    <td className="mono small" style={{ width: 200 }}>
                                      {finding.path}
                                      {finding.line ? `:${finding.line}` : ''}
                                    </td>
                                    <td className="small">
                                      {finding.body}
                                      <div className="muted">→ {finding.suggestion}</div>
                                    </td>
                                  </tr>
                                ))}
                              </tbody>
                            </table>
                          ) : null}
                        </div>
                      ))}
                    </div>
                  ))
                )}
              </>
            ) : null}
          </div>
        );
      })}
    </>
  );
}

// ── QA ─────────────────────────────────────────────────────────────────────

interface TestCase {
  id: string;
  ref: string;
  title: string;
  type: string;
  priority: string;
  status: string;
  result: string;
  expectedResult: string;
  steps: { action: string; expected?: string }[];
  evidence: { observed?: string; evidence?: string };
  story: { ref: string };
}

interface Bug {
  id: string;
  ref: string;
  title: string;
  description: string;
  severity: string;
  status: string;
  rootCause: string;
  isTestDefect: boolean;
  testCaseRefs: string[];
  story: { ref: string };
}

export function Qa({ projectKey }: { projectKey: string }) {
  const { data } = useApi<{ testCases: TestCase[]; bugs: Bug[] }>(`/projects/${projectKey}/qa`, 6000);
  const [open, setOpen] = useState<string | null>(null);

  if (!data?.testCases.length && !data?.bugs.length) {
    return (
      <div className="card">
        <Empty>No test cases yet. QA runs once the code review gate is approved.</Empty>
      </div>
    );
  }

  const notRun = data.testCases.filter((testCase) => testCase.result === 'NOT_RUN').length;

  return (
    <>
      {notRun > 0 ? (
        <div className="banner warn">
          {notRun} case(s) were designed but never actually executed. QA reports those as{' '}
          <strong>not run</strong> rather than passing them — grant it a browser or shell server on
          the MCP page if you want them really run.
        </div>
      ) : null}

      <div className="card table-card">
        <table>
          <thead>
            <tr>
              <th>Ref</th>
              <th>Story</th>
              <th>Test</th>
              <th>Type</th>
              <th>Result</th>
            </tr>
          </thead>
          <tbody>
            {data.testCases.map((testCase) => (
              <Fragment key={testCase.id}>
                <tr>
                  <td className="mono small">{testCase.ref.split('/').pop()}</td>
                  <td className="mono small">{testCase.story.ref}</td>
                  <td>
                    <a
                      href="#"
                      onClick={(event) => {
                        event.preventDefault();
                        setOpen(open === testCase.id ? null : testCase.id);
                      }}
                    >
                      {testCase.title}
                    </a>
                  </td>
                  <td className="small muted">{testCase.type.replace(/_/g, ' ').toLowerCase()}</td>
                  <td>
                    <span
                      className={`badge ${
                        testCase.result === 'PASSED'
                          ? 'ok'
                          : testCase.result === 'FAILED'
                            ? 'danger'
                            : 'muted'
                      }`}
                    >
                      {testCase.result.replace(/_/g, ' ').toLowerCase()}
                    </span>
                  </td>
                </tr>
                {open === testCase.id ? (
                  <tr>
                    <td colSpan={5}>
                      <h3>Steps</h3>
                      <ol style={{ margin: '0 0 10px 18px' }}>
                        {testCase.steps.map((step, index) => (
                          <li key={index}>
                            {step.action}
                            {step.expected ? <span className="muted"> → {step.expected}</span> : null}
                          </li>
                        ))}
                      </ol>
                      <div className="small">
                        <strong>Expected:</strong> {testCase.expectedResult}
                      </div>
                      {testCase.evidence?.observed ? (
                        <div className="small" style={{ marginTop: 6 }}>
                          <strong>Observed:</strong> {testCase.evidence.observed}
                          <div className="muted">How established: {testCase.evidence.evidence}</div>
                        </div>
                      ) : null}
                    </td>
                  </tr>
                ) : null}
              </Fragment>
            ))}
          </tbody>
        </table>
      </div>

      {data.bugs.length ? (
        <div className="card">
          <h2>Bugs</h2>
          {data.bugs.map((bug) => (
            <div key={bug.id} style={{ marginBottom: 12 }}>
              <div className="row">
                <Status value={bug.severity} />
                <strong>{bug.ref.split('/').pop()}</strong> {bug.title}
                <Status value={bug.status} />
                {bug.isTestDefect ? <span className="badge warn">test defect</span> : null}
                <span className="mono muted small">{bug.story.ref}</span>
              </div>
              <div className="small">{bug.description}</div>
              <div className="muted small">
                <strong>Root cause:</strong> {bug.rootCause}
              </div>
            </div>
          ))}
        </div>
      ) : null}
    </>
  );
}
