/**
 * @sdlc/context — the Context Engine, its recipes, and embedding providers.
 *
 * Never "send the whole project to the LLM", and never let an agent choose its own context
 * silently. Composition is declared, retrieved by the platform, and recorded.
 */

export * from './embeddings.js';
export * from './recipes.js';
export * from './context-engine.js';
export * from './workspace-resolvers.js';
