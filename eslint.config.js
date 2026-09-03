// @ts-check
/**
 * The determinism firewall, enforced.
 *
 * docs/12 says workflow code may import only `@temporalio/workflow`, `@sdlc/shared` and activity
 * *types*. That rule is worth nothing as prose: this config turns it into a lint error, and the
 * replay tests catch anything that slips past.
 *
 * This is not hypothetical. `@sdlc/shared` originally re-exported a config loader that imports
 * `node:fs`; the workflow bundler rejected it, which is why `@sdlc/shared/node` exists as a
 * separate entry point.
 */

import tseslint from '@typescript-eslint/eslint-plugin';
import tsparser from '@typescript-eslint/parser';

/** Modules a workflow must never reach for. */
const FORBIDDEN_IN_WORKFLOWS = [
  { name: '@sdlc/database', message: 'Workflows perform no I/O. Use an activity.' },
  { name: '@sdlc/shared/node', message: 'That entry point touches the filesystem. Use an activity.' },
  { name: '@sdlc/ai-router', message: 'Model calls belong in activities, not workflow code.' },
  { name: '@sdlc/ai-providers', message: 'Model calls belong in activities, not workflow code.' },
  { name: '@sdlc/mcp-manager', message: 'Tool calls belong in activities, not workflow code.' },
  { name: '@sdlc/context', message: 'Context building performs I/O. Use an activity.' },
  { name: '@sdlc/agent-runtime', message: 'The agent runtime is an activity, not workflow code.' },
  { name: '@prisma/client', message: 'Workflows perform no database access.' },
  { name: 'node:fs', message: 'Workflows perform no filesystem access.' },
  { name: 'node:path', message: 'Workflows perform no filesystem access.' },
  { name: 'node:crypto', message: 'Use workflow.uuid4() — node:crypto is non-deterministic.' },
  { name: 'node:child_process', message: 'Workflows spawn nothing.' },
  { name: 'ioredis', message: 'Workflows perform no I/O.' },
  { name: 'axios', message: 'Workflows perform no network I/O.' },
];

export default [
  {
    ignores: [
      '**/dist/**',
      '**/.next/**',
      '**/node_modules/**',
      '**/*.d.ts',
      '**/.turbo/**',
      'packages/database/prisma/**',
    ],
  },

  {
    files: ['**/*.ts', '**/*.tsx'],
    languageOptions: {
      parser: tsparser,
      parserOptions: { ecmaVersion: 2023, sourceType: 'module' },
    },
    plugins: { '@typescript-eslint': tseslint },
    rules: {
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
      'no-console': ['warn', { allow: ['warn', 'error'] }],
      eqeqeq: ['error', 'smart'],
    },
  },

  // ── Invariant I1: workflow code is deterministic ────────────────────────
  // Tests are excluded: they drive workflows from outside the sandbox and legitimately need paths,
  // clients and clocks. The rule protects workflow *source*, which is what Temporal bundles.
  {
    files: ['packages/workflows/src/**/*.ts'],
    ignores: ['packages/workflows/src/**/*.test.ts'],
    rules: {
      'no-restricted-imports': ['error', { paths: FORBIDDEN_IN_WORKFLOWS }],
      'no-restricted-globals': [
        'error',
        { name: 'Date', message: 'Use workflow.now() — Date is non-deterministic on replay.' },
        { name: 'setTimeout', message: 'Use workflow.sleep().' },
        { name: 'setInterval', message: 'Use workflow.sleep() in a loop.' },
        { name: 'fetch', message: 'Workflows perform no network I/O. Use an activity.' },
      ],
      'no-restricted-syntax': [
        'error',
        {
          selector: "CallExpression[callee.object.name='Math'][callee.property.name='random']",
          message: 'Use workflow.uuid4() — Math.random() breaks replay determinism.',
        },
        {
          selector: "CallExpression[callee.object.name='Date'][callee.property.name='now']",
          message: 'Use workflow.now() — Date.now() breaks replay determinism.',
        },
        {
          selector: "NewExpression[callee.name='Date']",
          message: 'Use workflow.now() — new Date() breaks replay determinism.',
        },
      ],
      // Console output from inside the sandbox is invisible anyway; use workflow log.
      'no-console': 'error',
    },
  },

  // ── The domain layer performs no I/O ────────────────────────────────────
  {
    files: ['packages/domain/src/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          paths: [
            { name: '@sdlc/database', message: 'The domain layer is pure. Pass data in.' },
            { name: '@prisma/client', message: 'The domain layer is pure. Pass data in.' },
            { name: 'node:fs', message: 'The domain layer is pure.' },
            { name: 'ioredis', message: 'The domain layer is pure.' },
          ],
        },
      ],
    },
  },

  {
    files: ['**/*.test.ts', 'tests/**/*.ts', 'infra/scripts/**/*.mjs'],
    rules: { 'no-console': 'off', '@typescript-eslint/no-explicit-any': 'off' },
  },
];
