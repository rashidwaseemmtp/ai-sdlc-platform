/**
 * Context recipes — docs/09 §2.
 *
 * Every agent declares what it needs. The recipe is data, so it can be inspected, versioned and
 * diffed — and so a bad output can be diagnosed as a bad input rather than a bad model.
 *
 * Priority 1 sections are never dropped. If one cannot fit, the run fails with INVALID_CONTEXT
 * rather than proceeding blind, because a BA that silently saw half the requirements produces a
 * backlog that looks fine and is wrong.
 */

import type { ContextRecipe } from '@sdlc/shared';

const RECIPES: Record<string, ContextRecipe> = {
  echo: {
    key: 'echo',
    tokenBudget: 4000,
    overflowStrategy: 'fail',
    sections: [
      { key: 'project-card', source: 'sql', priority: 1, maxTokens: 1000, format: 'markdown', required: true },
    ],
  },

  'product-owner': {
    key: 'product-owner',
    tokenBudget: 120_000,
    overflowStrategy: 'summarize',
    sections: [
      { key: 'project-card', source: 'sql', priority: 1, maxTokens: 1500, format: 'markdown', required: true },
      { key: 'source-documents', source: 'sql', priority: 1, maxTokens: 80_000, format: 'markdown', required: true },
      { key: 'existing-requirements', source: 'sql', priority: 2, maxTokens: 15_000, format: 'json', required: false },
      { key: 'product-decisions', source: 'sql', priority: 2, maxTokens: 5000, format: 'json', required: false },
      { key: 'open-questions', source: 'sql', priority: 2, maxTokens: 4000, format: 'json', required: false },
      { key: 'review-feedback', source: 'sql', priority: 1, maxTokens: 6000, format: 'json', required: false },
    ],
  },

  'business-analyst': {
    key: 'business-analyst',
    tokenBudget: 120_000,
    overflowStrategy: 'summarize',
    sections: [
      { key: 'project-card', source: 'sql', priority: 1, maxTokens: 1500, format: 'markdown', required: true },
      { key: 'product-vision', source: 'sql', priority: 1, maxTokens: 2000, format: 'json', required: false },
      // Priority 1: a backlog built from a *sample* of the requirements is simply wrong.
      { key: 'approved-requirements', source: 'sql', priority: 1, maxTokens: 40_000, format: 'json', required: true },
      { key: 'business-rules', source: 'sql', priority: 1, maxTokens: 8000, format: 'json', required: false },
      { key: 'existing-backlog', source: 'sql', priority: 2, maxTokens: 30_000, format: 'json', required: false },
      { key: 'meeting-excerpts', source: 'vector', query: { topK: 12 }, priority: 2, maxTokens: 20_000, format: 'markdown', required: false },
      { key: 'open-questions', source: 'sql', priority: 2, maxTokens: 4000, format: 'json', required: false },
      { key: 'review-feedback', source: 'sql', priority: 1, maxTokens: 8000, format: 'json', required: false },
    ],
  },

  architect: {
    key: 'architect',
    tokenBudget: 150_000,
    overflowStrategy: 'summarize',
    sections: [
      { key: 'project-card', source: 'sql', priority: 1, maxTokens: 1500, format: 'markdown', required: true },
      { key: 'approved-backlog', source: 'sql', priority: 1, maxTokens: 50_000, format: 'json', required: true },
      { key: 'non-functional-requirements', source: 'sql', priority: 1, maxTokens: 10_000, format: 'json', required: false },
      { key: 'constraints', source: 'sql', priority: 1, maxTokens: 6000, format: 'json', required: false },
      { key: 'repositories', source: 'sql', priority: 2, maxTokens: 3000, format: 'json', required: false },
      { key: 'existing-code-survey', source: 'git', priority: 3, maxTokens: 25_000, format: 'code', required: false },
      { key: 'prior-adrs', source: 'sql', priority: 1, maxTokens: 10_000, format: 'json', required: false },
    ],
  },

  'architecture-critic': {
    key: 'architecture-critic',
    tokenBudget: 150_000,
    overflowStrategy: 'fail',
    sections: [
      { key: 'project-card', source: 'sql', priority: 1, maxTokens: 1500, format: 'markdown', required: true },
      // The options arrive author-blind and label-shuffled, so the critic cannot anchor on "A".
      { key: 'architecture-options-blind', source: 'artifact', priority: 1, maxTokens: 90_000, format: 'json', required: true },
      { key: 'non-functional-requirements', source: 'sql', priority: 1, maxTokens: 10_000, format: 'json', required: false },
      { key: 'constraints', source: 'sql', priority: 1, maxTokens: 6000, format: 'json', required: false },
      { key: 'backlog-summary', source: 'sql', priority: 2, maxTokens: 15_000, format: 'json', required: false },
    ],
  },

  estimator: {
    key: 'estimator',
    tokenBudget: 100_000,
    overflowStrategy: 'summarize',
    sections: [
      { key: 'project-card', source: 'sql', priority: 1, maxTokens: 1500, format: 'markdown', required: true },
      { key: 'approved-backlog', source: 'sql', priority: 1, maxTokens: 50_000, format: 'json', required: true },
      { key: 'approved-architecture', source: 'sql', priority: 1, maxTokens: 20_000, format: 'json', required: false },
      { key: 'prior-adrs', source: 'sql', priority: 2, maxTokens: 8000, format: 'json', required: false },
      { key: 'historical-estimates', source: 'sql', priority: 3, maxTokens: 10_000, format: 'json', required: false },
    ],
  },

  'resource-planner': {
    key: 'resource-planner',
    tokenBudget: 60_000,
    overflowStrategy: 'summarize',
    sections: [
      { key: 'project-card', source: 'sql', priority: 1, maxTokens: 1500, format: 'markdown', required: true },
      { key: 'estimates', source: 'sql', priority: 1, maxTokens: 30_000, format: 'json', required: true },
      { key: 'approved-architecture', source: 'sql', priority: 2, maxTokens: 12_000, format: 'json', required: false },
      { key: 'constraints', source: 'sql', priority: 2, maxTokens: 5000, format: 'json', required: false },
    ],
  },

  'delivery-planner': {
    key: 'delivery-planner',
    tokenBudget: 80_000,
    overflowStrategy: 'summarize',
    sections: [
      { key: 'project-card', source: 'sql', priority: 1, maxTokens: 1500, format: 'markdown', required: true },
      { key: 'approved-backlog', source: 'sql', priority: 1, maxTokens: 40_000, format: 'json', required: true },
      { key: 'estimates', source: 'sql', priority: 1, maxTokens: 20_000, format: 'json', required: true },
      { key: 'resource-plan', source: 'sql', priority: 1, maxTokens: 8000, format: 'json', required: false },
      { key: 'story-dependencies', source: 'sql', priority: 1, maxTokens: 8000, format: 'json', required: false },
    ],
  },

  developer: {
    key: 'developer',
    tokenBudget: 180_000,
    overflowStrategy: 'drop-lowest-priority',
    sections: [
      { key: 'project-card', source: 'sql', priority: 1, maxTokens: 1500, format: 'markdown', required: true },
      { key: 'story', source: 'sql', priority: 1, maxTokens: 8000, format: 'json', required: true },
      { key: 'acceptance-criteria', source: 'sql', priority: 1, maxTokens: 6000, format: 'json', required: true },
      { key: 'approved-architecture', source: 'sql', priority: 1, maxTokens: 15_000, format: 'json', required: false },
      { key: 'prior-adrs', source: 'sql', priority: 1, maxTokens: 10_000, format: 'json', required: false },
      { key: 'tasks', source: 'sql', priority: 2, maxTokens: 5000, format: 'json', required: false },
      // Repository conventions are priority 1: they are how an agent writes code that matches
      // the surrounding style instead of its own house style.
      { key: 'coding-standards', source: 'git', priority: 1, maxTokens: 10_000, format: 'markdown', required: false },
      { key: 'relevant-code', source: 'git', priority: 2, maxTokens: 80_000, format: 'code', required: false },
      { key: 'design-references', source: 'sql', priority: 2, maxTokens: 8000, format: 'json', required: false },
      { key: 'review-feedback', source: 'sql', priority: 1, maxTokens: 10_000, format: 'json', required: false },
    ],
  },

  'code-reviewer': {
    key: 'code-reviewer',
    tokenBudget: 150_000,
    overflowStrategy: 'drop-lowest-priority',
    sections: [
      { key: 'story', source: 'sql', priority: 1, maxTokens: 6000, format: 'json', required: true },
      { key: 'acceptance-criteria', source: 'sql', priority: 1, maxTokens: 5000, format: 'json', required: true },
      { key: 'pull-request-diff', source: 'git', priority: 1, maxTokens: 90_000, format: 'code', required: true },
      { key: 'approved-architecture', source: 'sql', priority: 2, maxTokens: 12_000, format: 'json', required: false },
      { key: 'coding-standards', source: 'git', priority: 1, maxTokens: 8000, format: 'markdown', required: false },
    ],
  },

  'security-reviewer': {
    key: 'security-reviewer',
    tokenBudget: 120_000,
    overflowStrategy: 'drop-lowest-priority',
    sections: [
      { key: 'pull-request-diff', source: 'git', priority: 1, maxTokens: 90_000, format: 'code', required: true },
      { key: 'dependency-manifest', source: 'git', priority: 1, maxTokens: 10_000, format: 'code', required: false },
      { key: 'security-requirements', source: 'sql', priority: 1, maxTokens: 6000, format: 'json', required: false },
    ],
  },

  qa: {
    key: 'qa',
    tokenBudget: 150_000,
    overflowStrategy: 'drop-lowest-priority',
    sections: [
      { key: 'story', source: 'sql', priority: 1, maxTokens: 8000, format: 'json', required: true },
      { key: 'acceptance-criteria', source: 'sql', priority: 1, maxTokens: 8000, format: 'json', required: true },
      { key: 'pull-request-diff', source: 'git', priority: 2, maxTokens: 60_000, format: 'code', required: false },
      { key: 'approved-architecture', source: 'sql', priority: 2, maxTokens: 10_000, format: 'json', required: false },
      { key: 'design-references', source: 'sql', priority: 2, maxTokens: 6000, format: 'json', required: false },
      { key: 'existing-tests', source: 'git', priority: 2, maxTokens: 25_000, format: 'code', required: false },
    ],
  },

  'bug-analyzer': {
    key: 'bug-analyzer',
    tokenBudget: 120_000,
    overflowStrategy: 'drop-lowest-priority',
    sections: [
      { key: 'story', source: 'sql', priority: 1, maxTokens: 6000, format: 'json', required: true },
      { key: 'failing-results', source: 'sql', priority: 1, maxTokens: 20_000, format: 'json', required: true },
      { key: 'test-evidence', source: 'sql', priority: 1, maxTokens: 10_000, format: 'json', required: false },
      { key: 'pull-request-diff', source: 'git', priority: 1, maxTokens: 60_000, format: 'code', required: false },
    ],
  },
};

export function getRecipe(key: string): ContextRecipe {
  const recipe = RECIPES[key];
  if (!recipe) {
    throw new Error(
      `no context recipe named "${key}". Recipes are declared, not inferred — add it to ` +
        'packages/context/src/recipes.ts.',
    );
  }
  return recipe;
}

export function listRecipes(): ContextRecipe[] {
  return Object.values(RECIPES);
}
