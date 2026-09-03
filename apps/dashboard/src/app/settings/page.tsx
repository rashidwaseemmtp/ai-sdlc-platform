import { safeGet } from '@/lib/api';
import { Badge, ErrorBanner } from '@/components/ui';

export const dynamic = 'force-dynamic';

interface Settings {
  demoMode: boolean;
  aiMergePermission: boolean;
  limits: Record<string, number>;
  gates: Record<string, { enabled: boolean; requiredRole: string; timeoutHours: number; autoApprove: boolean }>;
  secretsConfigured: Record<string, boolean>;
}

interface Models {
  providers: { key: string; kind: string; billingMode: string; enabled: boolean; healthStatus: string }[];
  catalog: { providerKey: string; modelId: string; tier: string; enabled: boolean; inputCostPer1M: number | null; outputCostPer1M: number | null; billingMode: string }[];
  routing: Record<string, { capability?: string; minimumTier?: string; effort?: string }>;
  configured: string[];
}

interface Mcp {
  servers: { key: string; name: string; transport: string; enabled: boolean; permissions: string[]; backend?: string }[];
  grants: { agentKey: string; server: string; tools: string; scopes: string[] }[];
}

export default async function SettingsPage() {
  const [settings, models, mcp] = await Promise.all([
    safeGet<Settings | null>('/settings', null),
    safeGet<Models | null>('/models', null),
    safeGet<Mcp | null>('/mcp/servers', null),
  ]);

  return (
    <>
      <h1>Settings</h1>
      <p className="lede">Everything operational is configuration. Secrets are referenced by name and are never displayed.</p>
      <ErrorBanner error={settings.error} />

      <h2>Safety rails</h2>
      <div className="card table-wrap">
        <table>
          <tbody>
            <tr>
              <th>Demo mode</th>
              <td><Badge tone={settings.data?.demoMode ? 'info' : 'muted'}>{String(settings.data?.demoMode)}</Badge></td>
              <td className="muted small">Mock model, GitHub, Figma and Playwright providers; no credentials needed.</td>
            </tr>
            <tr>
              <th>AI merge</th>
              <td><Badge tone={settings.data?.aiMergePermission ? 'danger' : 'ok'}>{String(settings.data?.aiMergePermission)}</Badge></td>
              <td className="muted small">When false, no agent can merge a pull request under any grant.</td>
            </tr>
            {Object.entries(settings.data?.limits ?? {}).map(([key, value]) => (
              <tr key={key}>
                <th>{key.replace(/([A-Z])/g, ' $1').toLowerCase()}</th>
                <td className="mono">{value}</td>
                <td className="muted small">Bounded loop / budget ceiling.</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <h2>Approval gates</h2>
      <div className="card table-wrap">
        <table>
          <thead><tr><th>Gate</th><th>Enabled</th><th>Required role</th><th>Timeout</th><th>Auto-approve</th></tr></thead>
          <tbody>
            {Object.entries(settings.data?.gates ?? {}).map(([key, gate]) => (
              <tr key={key}>
                <td className="mono">{key}</td>
                <td><Badge tone={gate.enabled ? 'ok' : 'danger'}>{gate.enabled ? 'enabled' : 'disabled'}</Badge></td>
                <td>{gate.requiredRole}</td>
                <td className="muted">{gate.timeoutHours}h</td>
                <td><Badge tone={gate.autoApprove ? 'danger' : 'ok'}>{String(gate.autoApprove)}</Badge></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <h2>Model providers</h2>
      <ErrorBanner error={models.error} />
      <div className="card table-wrap">
        <table>
          <thead><tr><th>Model</th><th>Provider</th><th>Tier</th><th>Billing</th><th>Cost /1M</th><th>Enabled</th></tr></thead>
          <tbody>
            {(models.data?.catalog ?? []).map((entry) => (
              <tr key={`${entry.providerKey}/${entry.modelId}`}>
                <td className="mono">{entry.modelId}</td>
                <td className="muted">{entry.providerKey}</td>
                <td><Badge tone={entry.tier === 'FRONTIER' ? 'info' : 'muted'}>{entry.tier.toLowerCase()}</Badge></td>
                <td className="muted small">{entry.billingMode.toLowerCase()}</td>
                <td className="muted small">
                  {entry.inputCostPer1M === null ? 'unverified' : `$${entry.inputCostPer1M} / $${entry.outputCostPer1M}`}
                </td>
                <td><Badge tone={entry.enabled ? 'ok' : 'muted'}>{entry.enabled ? 'on' : 'off'}</Badge></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="muted small">Providers declared in config: {models.data?.configured.join(', ')}</p>

      <h2>Agent routing</h2>
      <div className="card table-wrap">
        <table>
          <thead><tr><th>Agent</th><th>Capability</th><th>Minimum tier</th><th>Effort</th></tr></thead>
          <tbody>
            {Object.entries(models.data?.routing ?? {}).map(([agentKey, routing]) => (
              <tr key={agentKey}>
                <td className="mono">{agentKey}</td>
                <td className="muted small">{routing.capability ?? '—'}</td>
                <td><Badge tone={routing.minimumTier === 'FRONTIER' ? 'info' : 'muted'}>{routing.minimumTier ?? '—'}</Badge></td>
                <td className="muted small">{routing.effort ?? '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <h2>MCP servers</h2>
      <ErrorBanner error={mcp.error} />
      <div className="card table-wrap">
        <table>
          <thead><tr><th>Server</th><th>Transport</th><th>Backend</th><th>Enabled</th><th>Permissions</th></tr></thead>
          <tbody>
            {(mcp.data?.servers ?? []).map((server) => (
              <tr key={server.key}>
                <td className="mono">{server.key}</td>
                <td className="muted small">{server.transport}</td>
                <td className="muted small">{server.backend ?? '—'}</td>
                <td><Badge tone={server.enabled ? 'ok' : 'muted'}>{server.enabled ? 'on' : 'off'}</Badge></td>
                <td className="muted small mono">{server.permissions.join(', ') || '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <h2>Secrets</h2>
      <div className="card">
        <p className="muted small" style={{ marginTop: 0 }}>Names and presence only. Values are write-only and never leave the server.</p>
        <div className="row">
          {Object.entries(settings.data?.secretsConfigured ?? {}).map(([name, present]) => (
            <Badge key={name} tone={present ? 'ok' : 'muted'}>{name}: {present ? 'set' : 'not set'}</Badge>
          ))}
        </div>
      </div>
    </>
  );
}
