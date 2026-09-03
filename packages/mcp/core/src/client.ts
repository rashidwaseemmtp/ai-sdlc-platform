/**
 * MCP client wrapper — one connection to one server, over any transport.
 *
 * Deliberately thin. Policy (permissions, argument checks, audit) belongs in the manager; this
 * layer only knows how to connect, list tools, call a tool, and tell whether the server is alive.
 */

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';
import {
  FailureCode,
  PlatformError,
  type McpServerConfig,
  type McpToolSchema,
} from '@sdlc/shared';

const CLIENT_INFO = { name: 'ai-sdlc-platform', version: '0.1.0' };

export interface McpCallResult {
  content: unknown;
  isError: boolean;
}

export class McpClient {
  private client?: Client;
  private connected = false;
  private lastUsedAt = Date.now();

  constructor(
    private readonly config: McpServerConfig,
    /** Resolved at connect time — config carries secret *references*, never values. */
    private readonly resolvedEnv: Record<string, string> = {},
  ) {}

  get serverKey(): string {
    return this.config.key;
  }

  get isConnected(): boolean {
    return this.connected;
  }

  get idleMs(): number {
    return Date.now() - this.lastUsedAt;
  }

  async connect(): Promise<void> {
    if (this.connected) return;

    const client = new Client(CLIENT_INFO, { capabilities: {} });
    try {
      await client.connect(this.buildTransport());
      this.client = client;
      this.connected = true;
      this.lastUsedAt = Date.now();
    } catch (error) {
      throw new PlatformError({
        code: FailureCode.MCP_UNAVAILABLE,
        message: `Could not connect to MCP server "${this.config.key}": ${(error as Error).message}`,
        details: { serverKey: this.config.key, transport: this.config.transport },
        cause: error,
      });
    }
  }

  async listTools(): Promise<McpToolSchema[]> {
    const client = await this.require();
    try {
      const result = await client.listTools();
      this.lastUsedAt = Date.now();
      return result.tools.map((tool) => ({
        serverKey: this.config.key,
        name: tool.name,
        description: tool.description ?? '',
        inputSchema: (tool.inputSchema ?? {}) as Record<string, unknown>,
      }));
    } catch (error) {
      throw this.transportError('tools/list', error);
    }
  }

  async callTool(name: string, args: Record<string, unknown>): Promise<McpCallResult> {
    const client = await this.require();
    try {
      const result = await client.callTool({ name, arguments: args });
      this.lastUsedAt = Date.now();
      return { content: result.content, isError: Boolean(result.isError) };
    } catch (error) {
      throw this.transportError(`tools/call ${name}`, error);
    }
  }

  async ping(): Promise<boolean> {
    try {
      await this.listTools();
      return true;
    } catch {
      return false;
    }
  }

  async close(): Promise<void> {
    try {
      await this.client?.close();
    } finally {
      this.client = undefined;
      this.connected = false;
    }
  }

  private async require(): Promise<Client> {
    if (!this.connected) await this.connect();
    if (!this.client) {
      throw new PlatformError({
        code: FailureCode.MCP_UNAVAILABLE,
        message: `MCP server "${this.config.key}" is not connected`,
        details: { serverKey: this.config.key },
      });
    }
    return this.client;
  }

  private buildTransport() {
    switch (this.config.transport) {
      case 'stdio': {
        if (!this.config.command) {
          throw new PlatformError({
            code: FailureCode.VALIDATION_ERROR,
            message: `stdio MCP server "${this.config.key}" has no command configured`,
          });
        }
        return new StdioClientTransport({
          command: this.config.command,
          args: this.config.args ?? [],
          // Only the explicitly resolved variables are passed through — an MCP child process
          // does not inherit the worker's whole environment (docs/07 §4).
          env: { PATH: process.env.PATH ?? '', ...this.resolvedEnv },
        });
      }
      case 'http': {
        return new StreamableHTTPClientTransport(new URL(this.requireUrl()), {
          requestInit: { headers: this.authHeaders() },
        });
      }
      case 'sse': {
        return new SSEClientTransport(new URL(this.requireUrl()), {
          requestInit: { headers: this.authHeaders() },
        });
      }
    }
  }

  private requireUrl(): string {
    if (!this.config.url) {
      throw new PlatformError({
        code: FailureCode.VALIDATION_ERROR,
        message: `MCP server "${this.config.key}" has no url configured`,
      });
    }
    return this.config.url;
  }

  private authHeaders(): Record<string, string> {
    const token = this.resolvedEnv.TOKEN ?? this.resolvedEnv.AUTH_TOKEN;
    return token ? { Authorization: `Bearer ${token}` } : {};
  }

  private transportError(operation: string, error: unknown): PlatformError {
    if (error instanceof PlatformError) return error;
    return new PlatformError({
      code: FailureCode.MCP_UNAVAILABLE,
      message: `MCP ${operation} failed on "${this.config.key}": ${(error as Error).message}`,
      details: { serverKey: this.config.key, operation },
      cause: error,
    });
  }
}
