/**
 * @sdlc/shared/node — the half of shared that touches the filesystem.
 *
 * Deliberately a separate entry point. Workflow code imports `@sdlc/shared` and gets types only;
 * if this module were re-exported from the main index, every workflow bundle would pull in
 * `node:fs` and the deterministic sandbox would reject it. That is not a hypothetical: it is the
 * failure this split was introduced to fix.
 */

export * from './config/loader.js';
