/**
 * Mock MCP servers — docs/65.
 *
 * These are selected by configuration (`backend: mock`), so the manager still binds tools, still
 * checks permissions and still audits. Only the far side of the transport is fake, which is what
 * lets the whole pipeline run end to end with no GitHub, Figma or browser credentials.
 */

import { MockMcpServer, type MockToolDefinition } from '@sdlc/mcp-core';

const str = { type: 'string' } as const;
const obj = (properties: Record<string, unknown>, required: string[] = []) => ({
  type: 'object',
  properties,
  required,
  additionalProperties: false,
});

// ── GitHub ─────────────────────────────────────────────────────────────────

export interface MockRepoState {
  files: Map<string, string>;
  branches: Map<string, string>;
  pullRequests: MockPullRequest[];
  nextPrNumber: number;
}

export interface MockPullRequest {
  number: number;
  title: string;
  body: string;
  head: string;
  base: string;
  state: 'open' | 'closed' | 'merged';
  url: string;
  checks: 'pending' | 'passing' | 'failing';
  comments: { path?: string; line?: number; body: string }[];
}

export class MockGitHub {
  readonly repos = new Map<string, MockRepoState>();

  ensureRepo(fullName: string, files: Record<string, string> = {}): MockRepoState {
    let repo = this.repos.get(fullName);
    if (!repo) {
      repo = {
        files: new Map(Object.entries(files)),
        branches: new Map([['main', 'sha-main-0']]),
        pullRequests: [],
        nextPrNumber: 1,
      };
      this.repos.set(fullName, repo);
    }
    return repo;
  }

  private require(fullName: string): MockRepoState {
    const repo = this.repos.get(fullName);
    if (!repo) throw new Error(`unknown repository: ${fullName}`);
    return repo;
  }

  toolDefinitions(): MockToolDefinition[] {
    return [
      {
        name: 'get_repository',
        description: 'Fetch repository metadata.',
        inputSchema: obj({ repo: str }, ['repo']),
        handler: ({ repo }) => {
          const state = this.require(repo as string);
          return {
            fullName: repo,
            defaultBranch: 'main',
            branches: [...state.branches.keys()],
            fileCount: state.files.size,
          };
        },
      },
      {
        name: 'get_file',
        description: 'Read a file at a ref.',
        inputSchema: obj({ repo: str, path: str, ref: str }, ['repo', 'path']),
        handler: ({ repo, path }) => {
          const state = this.require(repo as string);
          const content = state.files.get(path as string);
          if (content === undefined) throw new Error(`file not found: ${String(path)}`);
          return { path, content };
        },
      },
      {
        name: 'search_code',
        description: 'Search repository contents.',
        inputSchema: obj({ repo: str, query: str }, ['repo', 'query']),
        handler: ({ repo, query }) => {
          const state = this.require(repo as string);
          const needle = String(query).toLowerCase();
          return [...state.files.entries()]
            .filter(([path, body]) => path.toLowerCase().includes(needle) || body.toLowerCase().includes(needle))
            .slice(0, 20)
            .map(([path]) => ({ path }));
        },
      },
      {
        name: 'list_branches',
        description: 'List branches.',
        inputSchema: obj({ repo: str }, ['repo']),
        handler: ({ repo }) => [...this.require(repo as string).branches.keys()],
      },
      {
        name: 'create_branch',
        description: 'Create a branch from a base.',
        inputSchema: obj({ repo: str, branch: str, base: str }, ['repo', 'branch']),
        handler: ({ repo, branch, base }) => {
          const state = this.require(repo as string);
          const from = (base as string) ?? 'main';
          if (!state.branches.has(from)) throw new Error(`base branch missing: ${from}`);
          state.branches.set(branch as string, `sha-${String(branch)}-0`);
          return { branch, base: from, created: true };
        },
      },
      {
        name: 'commit',
        description: 'Commit file changes to a branch.',
        inputSchema: obj(
          {
            repo: str,
            branch: str,
            message: str,
            files: { type: 'array', items: obj({ path: str, content: str }, ['path', 'content']) },
          },
          ['repo', 'branch', 'message', 'files'],
        ),
        handler: ({ repo, branch, message, files }) => {
          const state = this.require(repo as string);
          if (!state.branches.has(branch as string)) throw new Error(`unknown branch: ${String(branch)}`);
          const changes = files as { path: string; content: string }[];
          for (const file of changes) state.files.set(file.path, file.content);
          const sha = `sha-${String(branch)}-${Date.now()}`;
          state.branches.set(branch as string, sha);
          return { sha, message, changed: changes.length };
        },
      },
      {
        name: 'push',
        description: 'Push a branch.',
        inputSchema: obj({ repo: str, branch: str }, ['repo', 'branch']),
        handler: ({ repo, branch }) => ({ pushed: branch, sha: this.require(repo as string).branches.get(branch as string) }),
      },
      {
        name: 'create_pull_request',
        description: 'Open a pull request.',
        inputSchema: obj({ repo: str, title: str, body: str, head: str, base: str }, ['repo', 'title', 'body', 'head']),
        handler: ({ repo, title, body, head, base }) => {
          const state = this.require(repo as string);
          const pr: MockPullRequest = {
            number: state.nextPrNumber++,
            title: title as string,
            body: body as string,
            head: head as string,
            base: (base as string) ?? 'main',
            state: 'open',
            url: `https://mock.github/${String(repo)}/pull/${state.nextPrNumber - 1}`,
            checks: 'passing',
            comments: [],
          };
          state.pullRequests.push(pr);
          return pr;
        },
      },
      {
        name: 'get_pull_request',
        description: 'Fetch a pull request.',
        inputSchema: obj({ repo: str, number: { type: 'number' } }, ['repo', 'number']),
        handler: ({ repo, number }) => {
          const pr = this.require(repo as string).pullRequests.find((p) => p.number === number);
          if (!pr) throw new Error(`no such pull request: ${String(number)}`);
          return pr;
        },
      },
      {
        name: 'update_pull_request',
        description: 'Update a pull request body or title.',
        inputSchema: obj({ repo: str, number: { type: 'number' }, title: str, body: str }, ['repo', 'number']),
        handler: ({ repo, number, title, body }) => {
          const pr = this.require(repo as string).pullRequests.find((p) => p.number === number);
          if (!pr) throw new Error(`no such pull request: ${String(number)}`);
          if (typeof title === 'string') pr.title = title;
          if (typeof body === 'string') pr.body = body;
          return pr;
        },
      },
      {
        name: 'get_checks',
        description: 'Fetch CI status for a pull request.',
        inputSchema: obj({ repo: str, number: { type: 'number' } }, ['repo', 'number']),
        handler: ({ repo, number }) => {
          const pr = this.require(repo as string).pullRequests.find((p) => p.number === number);
          return { state: pr?.checks ?? 'pending' };
        },
      },
      {
        name: 'get_comments',
        description: 'Fetch review comments.',
        inputSchema: obj({ repo: str, number: { type: 'number' } }, ['repo', 'number']),
        handler: ({ repo, number }) =>
          this.require(repo as string).pullRequests.find((p) => p.number === number)?.comments ?? [],
      },
      // NOTE: merge_pull_request exists here so a permission test can prove it is *denied* —
      // the mock must not be more permissive than production (invariant I7).
      {
        name: 'merge_pull_request',
        description: 'Merge a pull request. Requires an explicit privileged grant.',
        inputSchema: obj({ repo: str, number: { type: 'number' } }, ['repo', 'number']),
        handler: ({ repo, number }) => {
          const pr = this.require(repo as string).pullRequests.find((p) => p.number === number);
          if (!pr) throw new Error(`no such pull request: ${String(number)}`);
          pr.state = 'merged';
          return pr;
        },
      },
    ];
  }

  server(): MockMcpServer {
    return new MockMcpServer({ key: 'github', tools: this.toolDefinitions() });
  }
}

// ── Figma ──────────────────────────────────────────────────────────────────

export interface MockFigmaFrame {
  nodeId: string;
  name: string;
  width: number;
  height: number;
  components: string[];
}

export function createMockFigma(frames: MockFigmaFrame[] = defaultFrames()): MockMcpServer {
  return new MockMcpServer({
    key: 'figma',
    tools: [
      {
        name: 'get_file',
        description: 'Fetch design file metadata.',
        inputSchema: obj({ fileKey: str }, ['fileKey']),
        handler: ({ fileKey }) => ({ fileKey, name: 'Customer Management SaaS', frameCount: frames.length }),
      },
      {
        name: 'get_frames',
        description: 'List frames (screens) in a design file.',
        inputSchema: obj({ fileKey: str }, ['fileKey']),
        handler: () => frames,
      },
      {
        name: 'get_node',
        description: 'Fetch a single node.',
        inputSchema: obj({ fileKey: str, nodeId: str }, ['fileKey', 'nodeId']),
        handler: ({ nodeId }) => frames.find((f) => f.nodeId === nodeId) ?? null,
      },
      {
        name: 'get_components',
        description: 'List reusable components.',
        inputSchema: obj({ fileKey: str }, ['fileKey']),
        handler: () => ['Button', 'Input', 'Table', 'Modal', 'Badge', 'Toast'],
      },
      {
        name: 'get_styles',
        description: 'Design tokens: colours, typography, spacing.',
        inputSchema: obj({ fileKey: str }, ['fileKey']),
        handler: () => ({
          colors: { primary: '#2563eb', danger: '#dc2626', surface: '#ffffff', text: '#0f172a' },
          typography: { heading: 'Inter 24/32 600', body: 'Inter 14/20 400' },
          spacing: [4, 8, 12, 16, 24, 32],
        }),
      },
      {
        name: 'export_assets',
        description: 'Export assets for a node.',
        inputSchema: obj({ fileKey: str, nodeId: str }, ['fileKey', 'nodeId']),
        handler: ({ nodeId }) => ({ nodeId, assets: [`mock://asset/${String(nodeId)}.svg`] }),
      },
    ],
  });
}

function defaultFrames(): MockFigmaFrame[] {
  return [
    { nodeId: '1:20', name: 'Customer list', width: 1440, height: 900, components: ['Table', 'Badge'] },
    { nodeId: '1:21', name: 'Customer detail', width: 1440, height: 1100, components: ['Input', 'Button'] },
    { nodeId: '1:22', name: 'Deactivate confirmation', width: 720, height: 420, components: ['Modal', 'Button'] },
  ];
}

// ── Playwright ─────────────────────────────────────────────────────────────

export interface ScriptedTestOutcome {
  testCaseRef: string;
  status: 'PASS' | 'FAIL';
  failureMessage?: string;
  durationMs?: number;
}

/**
 * The scripted outcomes are what make the QA fix loop testable offline: the demo scripts one
 * failure, the bug analyser and developer run, and the re-test passes.
 */
export class MockPlaywright {
  private outcomes = new Map<string, ScriptedTestOutcome>();
  private consoleErrors: string[] = [];
  readonly navigations: string[] = [];

  script(outcomes: ScriptedTestOutcome[]): void {
    for (const outcome of outcomes) this.outcomes.set(outcome.testCaseRef, outcome);
  }

  /** Flip a previously failing test to passing — used after a simulated fix. */
  resolve(testCaseRef: string): void {
    const existing = this.outcomes.get(testCaseRef);
    if (existing) this.outcomes.set(testCaseRef, { ...existing, status: 'PASS', failureMessage: undefined });
  }

  server(): MockMcpServer {
    return new MockMcpServer({
      key: 'playwright',
      tools: [
        {
          name: 'open_browser',
          description: 'Launch a browser.',
          inputSchema: obj({ headless: { type: 'boolean' } }),
          handler: () => ({ sessionId: 'mock-session' }),
        },
        {
          name: 'navigate',
          description: 'Navigate to a URL.',
          inputSchema: obj({ url: str }, ['url']),
          handler: ({ url }) => {
            this.navigations.push(url as string);
            return { url, status: 200 };
          },
        },
        {
          name: 'click',
          description: 'Click an element.',
          inputSchema: obj({ selector: str }, ['selector']),
          handler: ({ selector }) => ({ clicked: selector }),
        },
        {
          name: 'fill',
          description: 'Fill an input.',
          inputSchema: obj({ selector: str, value: str }, ['selector', 'value']),
          handler: ({ selector, value }) => ({ filled: selector, value }),
        },
        {
          name: 'assert',
          description: 'Assert UI state for a test case.',
          inputSchema: obj({ testCaseRef: str, selector: str, expected: str }, ['testCaseRef']),
          handler: ({ testCaseRef }) => {
            const outcome = this.outcomes.get(testCaseRef as string) ?? {
              testCaseRef: testCaseRef as string,
              status: 'PASS' as const,
            };
            if (outcome.status === 'FAIL') {
              this.consoleErrors.push(outcome.failureMessage ?? 'assertion failed');
            }
            return outcome;
          },
        },
        {
          name: 'screenshot',
          description: 'Capture a screenshot as evidence.',
          inputSchema: obj({ name: str }, ['name']),
          handler: ({ name }) => ({ kind: 'SCREENSHOT', path: `mock://evidence/${String(name)}.png` }),
        },
        {
          name: 'get_console_logs',
          description: 'Return console errors captured during the run.',
          inputSchema: obj({}),
          handler: () => this.consoleErrors,
        },
        {
          name: 'get_network_log',
          description: 'Return network activity.',
          inputSchema: obj({}),
          handler: () => [{ url: 'mock://api/customers', status: 200, method: 'GET' }],
        },
        {
          name: 'accessibility_snapshot',
          description: 'Return an accessibility tree snapshot.',
          inputSchema: obj({}),
          handler: () => ({ violations: [], passes: 24 }),
        },
        {
          name: 'close',
          description: 'Close the browser.',
          inputSchema: obj({}),
          handler: () => ({ closed: true }),
        },
      ],
    });
  }
}
