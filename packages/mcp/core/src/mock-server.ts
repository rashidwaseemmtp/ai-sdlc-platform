/**
 * MockMCPServer — an in-process MCP server backed by fixtures.
 *
 * Selected by configuration (`backend: mock`), so the code path under test is the real one: the
 * manager still binds tools, still checks permissions, still audits. Only the transport is short
 * -circuited, which is what lets the whole GitHub/Figma/Playwright pipeline run with no
 * credentials (docs/65).
 */

import { FailureCode, PlatformError, type McpToolSchema } from '@sdlc/shared';
import type { McpCallResult } from './client.js';

export type MockToolHandler = (args: Record<string, unknown>) => unknown | Promise<unknown>;

export interface MockToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  handler: MockToolHandler;
}

export interface MockServerOptions {
  key: string;
  tools: MockToolDefinition[];
  /** Simulate an unhealthy server without changing any configuration. */
  healthy?: boolean;
  latencyMs?: number;
}

export class MockMcpServer {
  private tools = new Map<string, MockToolDefinition>();
  private healthy: boolean;
  readonly calls: { tool: string; args: Record<string, unknown> }[] = [];

  constructor(private readonly options: MockServerOptions) {
    for (const tool of options.tools) this.tools.set(tool.name, tool);
    this.healthy = options.healthy ?? true;
  }

  get serverKey(): string {
    return this.options.key;
  }

  get isConnected(): boolean {
    return this.healthy;
  }

  get idleMs(): number {
    return 0;
  }

  setHealthy(healthy: boolean): void {
    this.healthy = healthy;
  }

  async connect(): Promise<void> {
    this.assertHealthy();
  }

  async listTools(): Promise<McpToolSchema[]> {
    this.assertHealthy();
    return [...this.tools.values()].map((tool) => ({
      serverKey: this.options.key,
      name: tool.name,
      description: tool.description,
      inputSchema: tool.inputSchema,
    }));
  }

  async callTool(name: string, args: Record<string, unknown>): Promise<McpCallResult> {
    this.assertHealthy();
    if (this.options.latencyMs) {
      await new Promise((resolve) => setTimeout(resolve, this.options.latencyMs));
    }

    const tool = this.tools.get(name);
    if (!tool) {
      return { content: `unknown tool: ${name}`, isError: true };
    }

    this.calls.push({ tool: name, args });
    try {
      return { content: await tool.handler(args), isError: false };
    } catch (error) {
      return { content: (error as Error).message, isError: true };
    }
  }

  async ping(): Promise<boolean> {
    return this.healthy;
  }

  async close(): Promise<void> {
    /* nothing to tear down */
  }

  private assertHealthy(): void {
    if (!this.healthy) {
      throw new PlatformError({
        code: FailureCode.MCP_UNAVAILABLE,
        message: `mock MCP server "${this.options.key}" is marked unhealthy`,
        details: { serverKey: this.options.key },
      });
    }
  }
}

/** The shape the manager depends on — real client and mock server are interchangeable. */
export interface McpConnection {
  readonly serverKey: string;
  readonly isConnected: boolean;
  readonly idleMs: number;
  connect(): Promise<void>;
  listTools(): Promise<McpToolSchema[]>;
  callTool(name: string, args: Record<string, unknown>): Promise<McpCallResult>;
  ping(): Promise<boolean>;
  close(): Promise<void>;
}
