/**
 * Artifacts, versions and lineage — docs/09 §5–6.
 *
 * An artifact is a logical document; a version is an immutable snapshot. Workflows pass refs,
 * never bodies (invariant I4), and approved versions are never mutated (invariant I3).
 */

export const ArtifactKind = {
  REQUIREMENTS: 'REQUIREMENTS',
  PRODUCT_VISION: 'PRODUCT_VISION',
  BACKLOG: 'BACKLOG',
  STORY: 'STORY',
  ARCHITECTURE_OPTION: 'ARCHITECTURE_OPTION',
  ARCHITECTURE_EVALUATION: 'ARCHITECTURE_EVALUATION',
  ARCHITECTURE_RECOMMENDATION: 'ARCHITECTURE_RECOMMENDATION',
  ADR: 'ADR',
  ESTIMATE: 'ESTIMATE',
  RESOURCE_PLAN: 'RESOURCE_PLAN',
  DELIVERY_PLAN: 'DELIVERY_PLAN',
  IMPLEMENTATION_PLAN: 'IMPLEMENTATION_PLAN',
  CODE_REVIEW: 'CODE_REVIEW',
  SECURITY_REVIEW: 'SECURITY_REVIEW',
  TEST_PLAN: 'TEST_PLAN',
  TEST_CASES: 'TEST_CASES',
  QA_REPORT: 'QA_REPORT',
  BUG: 'BUG',
  RELEASE_NOTES: 'RELEASE_NOTES',
} as const;
export type ArtifactKind = (typeof ArtifactKind)[keyof typeof ArtifactKind];

export const ArtifactScope = {
  PROJECT: 'PROJECT',
  STORY: 'STORY',
  OPTION: 'OPTION',
  PR: 'PR',
} as const;
export type ArtifactScope = (typeof ArtifactScope)[keyof typeof ArtifactScope];

export const RecordStatus = {
  DRAFT: 'DRAFT',
  REVIEW: 'REVIEW',
  APPROVED: 'APPROVED',
  SUPERSEDED: 'SUPERSEDED',
  REJECTED: 'REJECTED',
} as const;
export type RecordStatus = (typeof RecordStatus)[keyof typeof RecordStatus];

/** The only artifact shape permitted in a Temporal workflow argument or return value. */
export interface ArtifactRef {
  artifactId: string;
  versionId: string;
  version: number;
  kind: ArtifactKind;
  sha256: string;
}

export interface ArtifactVersionRecord<T = unknown> {
  id: string;
  artifactId: string;
  version: number;
  content: T;
  contentSha256: string;
  status: RecordStatus;
  producedByRunId?: string;
  approvedByUserId?: string;
  approvedAt?: string;
  qualityWarnings: unknown[];
  createdAt: string;
}

export const LineageRelation = {
  DERIVED_FROM: 'DERIVED_FROM',
  REVISION_OF: 'REVISION_OF',
  CRITIQUE_OF: 'CRITIQUE_OF',
  SUPERSEDES: 'SUPERSEDES',
} as const;
export type LineageRelation = (typeof LineageRelation)[keyof typeof LineageRelation];

export interface LineageEdge {
  childVersionId: string;
  parentVersionId: string;
  relation: LineageRelation;
}

/** Human-facing artifact name, e.g. `architecture-option-a-v1` (docs/42). */
export function artifactDisplayName(
  kind: ArtifactKind,
  version: number,
  discriminator?: string,
): string {
  const base = kind.toLowerCase().replace(/_/g, '-');
  return discriminator
    ? `${base}-${discriminator.toLowerCase()}-v${version}`
    : `${base}-v${version}`;
}
