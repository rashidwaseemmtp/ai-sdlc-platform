/**
 * Prompt registry — docs/55.
 *
 * Prompts live on disk under `prompts/<agent>/vN.md`, are hashed, and are *pinned per run*. A run
 * records the exact version and sha it used, which is what makes historical agent behaviour
 * reproducible: "why did the architect say that in March" is answerable.
 *
 * Prompt files are never edited in place. A change is a new version.
 */

import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { FailureCode, PlatformError, type AgentKey, type PromptRef } from '@sdlc/shared';
import { sha256 } from '@sdlc/ai-core';

export interface LoadedPrompt extends PromptRef {
  body: string;
}

export class PromptRegistry {
  private cache = new Map<string, LoadedPrompt>();

  constructor(private readonly promptsDir: string = resolve(process.cwd(), 'prompts')) {}

  get(agentKey: AgentKey, version: string): LoadedPrompt {
    const cacheKey = `${agentKey}/${version}`;
    const cached = this.cache.get(cacheKey);
    if (cached) return cached;

    const path = join(this.promptsDir, agentKey, `${version}.md`);
    if (!existsSync(path)) {
      throw new PlatformError({
        code: FailureCode.NOT_FOUND,
        message: `prompt not found: ${agentKey}/${version}.md`,
        details: { agentKey, version, path, available: this.listVersions(agentKey) },
      });
    }

    const body = readFileSync(path, 'utf8');
    const loaded: LoadedPrompt = {
      agentKey,
      version,
      path: `${agentKey}/${version}.md`,
      sha256: sha256(body),
      body,
    };
    this.cache.set(cacheKey, loaded);
    return loaded;
  }

  listVersions(agentKey: AgentKey): string[] {
    const dir = join(this.promptsDir, agentKey);
    if (!existsSync(dir)) return [];
    return readdirSync(dir)
      .filter((file) => file.endsWith('.md'))
      .map((file) => file.replace(/\.md$/, ''))
      .sort(compareVersions);
  }

  latest(agentKey: AgentKey): string {
    const versions = this.listVersions(agentKey);
    const latest = versions.at(-1);
    if (!latest) {
      throw new PlatformError({
        code: FailureCode.NOT_FOUND,
        message: `no prompts found for agent "${agentKey}"`,
        details: { agentKey, promptsDir: this.promptsDir },
      });
    }
    return latest;
  }

  /**
   * Render a prompt with `{{variable}}` substitution.
   *
   * Substitution is deliberately dumb: no logic, no loops, no partials. A prompt that needs
   * branching is two prompts, because a template language would make the rendered text a function
   * of code that is not versioned alongside it.
   */
  render(prompt: LoadedPrompt, variables: Record<string, string> = {}): string {
    return prompt.body.replace(/\{\{(\w+)\}\}/g, (match, name: string) => {
      const value = variables[name];
      if (value === undefined) {
        throw new PlatformError({
          code: FailureCode.VALIDATION_ERROR,
          message: `prompt ${prompt.path} references {{${name}}} but no value was supplied`,
          details: { prompt: prompt.path, variable: name, supplied: Object.keys(variables) },
        });
      }
      return value;
    });
  }

  clearCache(): void {
    this.cache.clear();
  }
}

function compareVersions(a: string, b: string): number {
  const numeric = (value: string): number => Number(value.replace(/\D/g, '')) || 0;
  return numeric(a) - numeric(b);
}
