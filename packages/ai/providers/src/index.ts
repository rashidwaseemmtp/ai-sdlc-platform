/**
 * @sdlc/ai-providers — one adapter per vendor, each using that vendor's official SDK.
 *
 * Adding a provider is one file plus one catalog entry. No agent, workflow or prompt changes,
 * which is the whole point of docs/67: the platform must never depend on one AI company.
 */

import { BillingMode, type ModelProvider, type ProviderKey } from '@sdlc/shared';
import { MockModelProvider } from './mock.js';
import { AnthropicProvider } from './anthropic.js';
import { OpenAICompatibleProvider } from './openai-compatible.js';
import { ClaudeSubscriptionProvider } from './claude-subscription.js';

export { MockModelProvider, type MockHandler, type MockFailure, type MockFixture } from './mock.js';
export { AnthropicProvider, type AnthropicProviderOptions } from './anthropic.js';
export { OpenAICompatibleProvider, type OpenAICompatibleOptions } from './openai-compatible.js';
export { ClaudeSubscriptionProvider, type ClaudeSubscriptionOptions } from './claude-subscription.js';

export interface ProviderRuntimeConfig {
  key: ProviderKey;
  enabled: boolean;
  billingMode: BillingMode;
  apiKey?: string;
  baseUrl?: string;
  command?: string;
  seats?: number;
  config?: Record<string, unknown>;
}

/**
 * Gemini's own OpenAI-compatible endpoint. Google publishes and supports this surface, so the
 * compatible adapter is a legitimate path rather than a shim — and it keeps one fewer SDK in the
 * dependency tree. Swap in a native `@google/genai` adapter here if Gemini-specific features
 * (thinking config, grounding) are needed; nothing outside this file changes.
 */
const GEMINI_OPENAI_BASE = 'https://generativelanguage.googleapis.com/v1beta/openai/';
const OPENROUTER_BASE = 'https://openrouter.ai/api/v1';

export function createProvider(config: ProviderRuntimeConfig): ModelProvider {
  switch (config.key) {
    case 'mock':
      return new MockModelProvider();

    case 'anthropic':
      return new AnthropicProvider({
        ...(config.apiKey ? { apiKey: config.apiKey } : {}),
        ...(config.baseUrl ? { baseUrl: config.baseUrl } : {}),
      });

    case 'claude-subscription':
      return new ClaudeSubscriptionProvider({
        ...(config.command ? { command: config.command } : {}),
      });

    case 'openai':
      return new OpenAICompatibleProvider({
        key: 'openai',
        ...(config.apiKey ? { apiKey: config.apiKey } : {}),
        ...(config.baseUrl ? { baseUrl: config.baseUrl } : {}),
      });

    case 'google':
      return new OpenAICompatibleProvider({
        key: 'google',
        ...(config.apiKey ? { apiKey: config.apiKey } : {}),
        baseUrl: config.baseUrl ?? GEMINI_OPENAI_BASE,
      });

    case 'openrouter':
      return new OpenAICompatibleProvider({
        key: 'openrouter',
        ...(config.apiKey ? { apiKey: config.apiKey } : {}),
        baseUrl: config.baseUrl ?? OPENROUTER_BASE,
        defaultHeaders: { 'X-Title': 'ai-sdlc-platform' },
      });

    case 'ollama':
      return new OpenAICompatibleProvider({
        key: 'ollama',
        baseUrl: `${(config.baseUrl ?? 'http://localhost:11434').replace(/\/$/, '')}/v1`,
        billingMode: BillingMode.LOCAL_FREE,
      });

    default:
      // Any other OpenAI-compatible endpoint, configured entirely from the database.
      return new OpenAICompatibleProvider({
        key: config.key,
        ...(config.apiKey ? { apiKey: config.apiKey } : {}),
        ...(config.baseUrl ? { baseUrl: config.baseUrl } : {}),
        billingMode: config.billingMode,
      });
  }
}
