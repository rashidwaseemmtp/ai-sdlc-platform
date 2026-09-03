/**
 * @sdlc/domain — business rules with no I/O.
 *
 * Nothing here touches a database, a network or a model. That is what makes the arithmetic of the
 * platform (variance thresholds, architecture scoring, dependency waves, backlog quality)
 * unit-testable and auditable, instead of something a language model is trusted to get right.
 */

export * from './planning.js';
export * from './estimation.js';
export * from './architecture.js';
export * from './backlog.js';
