import { safeGet } from '@/lib/api';
import { Badge, Empty, ErrorBanner, StatusBadge, duration } from '@/components/ui';

export const dynamic = 'force-dynamic';

interface RunDetail {
  id: string;
  agentKey: string;
  agentVersion: number;
  phase: string | null;
  status: string;
  attempt: number;
  startedAt: string;
  finishedAt: string | null;
  durationMs: number | null;
  totalCostUsd: number;
  totalTokens: number;
  error: { code?: string; message?: string; details?: unknown } | null;
  decisionSummary: {
    summary: string;
    assumptions: string[];
    risks: { description: string; severity: string }[];
    confidence: number;
  } | null;
  contextSha256: string | null;
  requestSha256: string | null;
  workflowId: string | null;
  project: { key: string; name: string } | null;
  promptVersion: { version: string; sha256: string; path: string } | null;
  llmCalls: {
    ordinal: number;
    providerKey: string;
    modelId: string;
    billingMode: string;
    promptTokens: number;
    completionTokens: number;
    cachedReadTokens: number;
    costUsd: number;
    costUnknown: boolean;
    quotaUnits: number;
    latencyMs: number;
    finishReason: string | null;
    fallbackFrom: string | null;
  }[];
  toolCalls: {
    ordinal: number;
    serverKey: string;
    toolName: string;
    status: string;
    permissionDecision: string;
    denyReason: string | null;
    durationMs: number;
    argumentsRedacted: unknown;
  }[];
  artifactVersions: { version: number; contentSha256: string; artifact: { kind: string; name: string } }[];
}

/** The audit record — docs/43. This is what answers "why did the agent do that?". */
export default async function RunPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const { data, error } = await safeGet<RunDetail | null>(`/agent-runs/${id}`, null);

  if (!data) {
    return (
      <>
        <h1>Agent run</h1>
        <ErrorBanner error={error ?? 'not found'} />
      </>
    );
  }

  return (
    <>
      <div className="row" style={{ justifyContent: 'space-between' }}>
        <div>
          <h1 className="mono">{data.agentKey}</h1>
          <p className="lede">
            {data.project?.key} · {data.phase ?? 'default'} · attempt {data.attempt}
          </p>
        </div>
        <StatusBadge status={data.status} />
      </div>

      {data.error ? (
        <div className="banner danger">
          <strong className="mono">{data.error.code}</strong> {data.error.message}
        </div>
      ) : null}

      <div className="grid cols-4">
        <div className="card">
          <div className="stat-label">Duration</div>
          <div className="stat">{duration(data.durationMs)}</div>
        </div>
        <div className="card">
          <div className="stat-label">Tokens</div>
          <div className="stat">{data.totalTokens.toLocaleString()}</div>
        </div>
        <div className="card">
          <div className="stat-label">Cost</div>
          <div className="stat">${data.totalCostUsd.toFixed(4)}</div>
        </div>
        <div className="card">
          <div className="stat-label">Model calls</div>
          <div className="stat">{data.llmCalls.length}</div>
        </div>
      </div>

      {data.decisionSummary ? (
        <>
          <h2>Decision summary</h2>
          <div className="card">
            <p style={{ marginTop: 0 }}>{data.decisionSummary.summary}</p>
            <div className="muted small">
              confidence {(data.decisionSummary.confidence * 100).toFixed(0)}%
            </div>
          </div>
        </>
      ) : null}

      {/* Reproducibility: prompt version + context hash + request hash pin this run exactly. */}
      <h2>Reproducibility</h2>
      <div className="card table-wrap">
        <table>
          <tbody>
            <tr>
              <th>Agent version</th>
              <td className="mono">v{data.agentVersion}</td>
              <th>Prompt</th>
              <td className="mono">
                {data.promptVersion ? `${data.promptVersion.path} @ ${data.promptVersion.sha256.slice(0, 12)}…` : '—'}
              </td>
            </tr>
            <tr>
              <th>Context hash</th>
              <td className="mono">{data.contextSha256?.slice(0, 16) ?? '—'}…</td>
              <th>Request hash</th>
              <td className="mono">{data.requestSha256?.slice(0, 16) ?? '—'}…</td>
            </tr>
            <tr>
              <th>Workflow</th>
              <td className="mono" colSpan={3}>{data.workflowId ?? '—'}</td>
            </tr>
          </tbody>
        </table>
      </div>

      <h2>Model calls</h2>
      {data.llmCalls.length === 0 ? (
        <Empty>No model calls recorded.</Empty>
      ) : (
        <div className="card table-wrap">
          <table>
            <thead>
              <tr>
                <th>#</th><th>Provider / model</th><th>Billing</th><th>Prompt</th><th>Completion</th>
                <th>Cached</th><th>Cost</th><th>Latency</th><th>Finish</th>
              </tr>
            </thead>
            <tbody>
              {data.llmCalls.map((call) => (
                <tr key={call.ordinal}>
                  <td>{call.ordinal}</td>
                  <td className="mono">
                    {call.providerKey}/{call.modelId}
                    {call.fallbackFrom ? (
                      <div className="small"><Badge tone="warn">fell back from {call.fallbackFrom}</Badge></div>
                    ) : null}
                  </td>
                  <td className="muted small">{call.billingMode.toLowerCase()}</td>
                  <td>{call.promptTokens.toLocaleString()}</td>
                  <td>{call.completionTokens.toLocaleString()}</td>
                  <td className="muted">{call.cachedReadTokens || '—'}</td>
                  <td>
                    {call.costUnknown ? <span className="muted">unknown</span> : `$${call.costUsd.toFixed(5)}`}
                    {call.quotaUnits ? <div className="small muted">{call.quotaUnits} quota</div> : null}
                  </td>
                  <td className="muted small">{call.latencyMs}ms</td>
                  <td className="muted small">{call.finishReason ?? '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <h2>Tool calls</h2>
      {data.toolCalls.length === 0 ? (
        <Empty>This agent called no tools.</Empty>
      ) : (
        <div className="card table-wrap">
          <table>
            <thead>
              <tr><th>#</th><th>Server</th><th>Tool</th><th>Permission</th><th>Status</th><th>Duration</th><th>Arguments</th></tr>
            </thead>
            <tbody>
              {data.toolCalls.map((call) => (
                <tr key={call.ordinal}>
                  <td>{call.ordinal}</td>
                  <td className="mono">{call.serverKey}</td>
                  <td className="mono">{call.toolName}</td>
                  <td>
                    <Badge tone={call.permissionDecision === 'ALLOWED' ? 'ok' : 'danger'}>
                      {call.permissionDecision.toLowerCase()}
                    </Badge>
                    {call.denyReason ? <div className="small muted">{call.denyReason}</div> : null}
                  </td>
                  <td><StatusBadge status={call.status} /></td>
                  <td className="muted small">{call.durationMs}ms</td>
                  <td className="mono small" style={{ maxWidth: 260, wordBreak: 'break-all' }}>
                    {JSON.stringify(call.argumentsRedacted).slice(0, 140)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <h2>Artifacts produced</h2>
      {data.artifactVersions.length === 0 ? (
        <Empty>No artifacts.</Empty>
      ) : (
        <div className="card">
          {data.artifactVersions.map((version, index) => (
            <div key={index} className="small">
              <span className="mono">{version.artifact.name}</span> v{version.version}{' '}
              <span className="muted">({version.artifact.kind.toLowerCase()}, sha {version.contentSha256.slice(0, 12)}…)</span>
            </div>
          ))}
        </div>
      )}
    </>
  );
}
