/**
 * @sdlc/ai-core — the provider-agnostic contract every model adapter implements.
 *
 * The interface is the *intersection* of what the platform needs, not the union of what vendors
 * offer. Provider-specific behaviour sits behind capability flags, and adapters degrade
 * explicitly rather than silently.
 */

export * from './tokens.js';
export * from './structured.js';

export type {
  ModelProvider,
  ModelRequest,
  ModelResponse,
  ModelChunk,
  ModelUsage,
  ProviderHealth,
  CatalogEntry,
  ChatMessage,
  ContentBlock,
  ToolSchema,
  ToolCall,
  ModelPolicy,
  ModelBinding,
  Capability,
  ModelTier,
  BillingMode,
  Effort,
  ProviderKey,
} from '@sdlc/shared';
