/**
 * Context Engine types — docs/09-context-and-artifacts.md.
 *
 * Context composition is declared and recorded, never chosen ad hoc by the model, so a bad output
 * can be diagnosed as a bad input.
 */

import type { ArtifactRef } from './artifact.js';

export type ContextRecipeKey = string;

export type ContextSourceKind = 'sql' | 'vector' | 'git' | 'artifact' | 'computed';

export interface ContextQuery {
  topK?: number;
  filter?: Record<string, unknown>;
  since?: string;
  limit?: number;
  [key: string]: unknown;
}

export interface ContextSection {
  key: string;
  source: ContextSourceKind;
  query?: ContextQuery;
  /** 1 is never dropped. Overflow drops 3, then 2, and fails if a priority-1 section cannot fit. */
  priority: 1 | 2 | 3;
  maxTokens: number;
  format: 'json' | 'markdown' | 'code';
  required: boolean;
}

export interface ContextRecipe {
  key: ContextRecipeKey;
  tokenBudget: number;
  overflowStrategy: 'summarize' | 'drop-lowest-priority' | 'fail';
  sections: ContextSection[];
}

export interface RenderedSection {
  key: string;
  content: string;
  tokenCount: number;
  truncated: boolean;
  summarized: boolean;
  itemCount: number;
}

export interface ContextPackage {
  recipeKey: ContextRecipeKey;
  sections: RenderedSection[];
  tokenCount: number;
  inputRefs: ArtifactRef[];
  /** With the prompt sha, this is what makes a historical run reproducible. */
  sha256: string;
  droppedSections: string[];
}
