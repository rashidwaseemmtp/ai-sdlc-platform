/**
 * Backlog quality analysis — docs/8, docs/57.
 *
 * The BA agent reports its own doubts as structured flags; this module independently *verifies*
 * them. Both matter: a model that forgets to flag a duplicate should still be caught, and a
 * quality gate that only trusts the model's self-report is not a gate.
 */

export interface StoryLike {
  ref: string;
  title: string;
  userStory: string;
  description: string;
  sizeSignal: 'XS' | 'S' | 'M' | 'L' | 'XL';
  acceptanceCriteria: {
    kind: 'GWT' | 'CHECKLIST';
    given?: string | null;
    when?: string | null;
    then?: string | null;
    statement?: string | null;
  }[];
  edgeCases: string[];
  requirementRefs: string[];
  labels: string[];
}

export type QualityFlagKind =
  | 'DUPLICATE'
  | 'AMBIGUOUS'
  | 'TOO_LARGE'
  | 'MISSING_AC'
  | 'TECHNICAL_AS_BUSINESS'
  | 'MISSING_EDGE_CASES'
  | 'CONFLICTING'
  | 'UNTESTABLE';

export interface QualityFlag {
  storyRef: string;
  kind: QualityFlagKind;
  detail: string;
  severity: 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';
}

const USER_STORY_SHAPE = /^as an?\s+.+?,\s*i want\s+.+?,\s*so that\s+.+$/i;

/** Words that make an acceptance criterion untestable because nobody can agree when it is met. */
const VAGUE_TERMS = [
  'fast', 'slow', 'quickly', 'easy', 'easily', 'intuitive', 'user-friendly', 'simple',
  'robust', 'scalable', 'efficient', 'appropriate', 'proper', 'reasonable', 'good',
  'better', 'optimal', 'seamless', 'modern', 'nice', 'etc', 'and so on', 'as needed',
];

/** Implementation vocabulary that suggests a technical task wearing a business story's clothes. */
const TECHNICAL_TERMS = [
  'refactor', 'database index', 'migration', 'endpoint', 'api route', 'redis', 'kafka',
  'docker', 'kubernetes', 'cache layer', 'orm', 'schema change', 'library upgrade',
  'dependency bump', 'unit test', 'ci pipeline',
];

export function analyseBacklog(stories: StoryLike[]): QualityFlag[] {
  const flags: QualityFlag[] = [];

  for (const story of stories) {
    flags.push(...analyseStory(story));
  }
  flags.push(...findDuplicates(stories));

  return flags;
}

export function analyseStory(story: StoryLike): QualityFlag[] {
  const flags: QualityFlag[] = [];
  const flag = (kind: QualityFlagKind, detail: string, severity: QualityFlag['severity']): void => {
    flags.push({ storyRef: story.ref, kind, detail, severity });
  };

  if (story.acceptanceCriteria.length === 0) {
    flag('MISSING_AC', 'story has no acceptance criteria and cannot be verified', 'CRITICAL');
  }

  for (const [index, criterion] of story.acceptanceCriteria.entries()) {
    if (criterion.kind === 'GWT') {
      const missing = (['given', 'when', 'then'] as const).filter((part) => !criterion[part]?.trim());
      if (missing.length) {
        flag(
          'MISSING_AC',
          `acceptance criterion ${index + 1} is Given/When/Then but is missing: ${missing.join(', ')}`,
          'HIGH',
        );
      }
    } else if (!criterion.statement?.trim()) {
      flag('MISSING_AC', `acceptance criterion ${index + 1} has no statement`, 'HIGH');
    }

    const text = [criterion.given, criterion.when, criterion.then, criterion.statement]
      .filter(Boolean)
      .join(' ')
      .toLowerCase();
    const vague = VAGUE_TERMS.filter((term) => new RegExp(`\\b${term}\\b`).test(text));
    if (vague.length) {
      flag(
        'UNTESTABLE',
        `acceptance criterion ${index + 1} uses unmeasurable language: ${vague.join(', ')}`,
        'MEDIUM',
      );
    }
  }

  if (!USER_STORY_SHAPE.test(story.userStory.trim())) {
    flag(
      'AMBIGUOUS',
      'user story does not follow "As a <role>, I want <capability>, so that <benefit>"',
      'MEDIUM',
    );
  }

  if (story.sizeSignal === 'XL') {
    flag('TOO_LARGE', 'XL stories should be split before development', 'HIGH');
  }

  if (story.edgeCases.length === 0) {
    flag('MISSING_EDGE_CASES', 'no edge cases identified', 'MEDIUM');
  }

  if (story.requirementRefs.length === 0) {
    flag(
      'AMBIGUOUS',
      'story does not trace to any requirement, so its business justification is unverifiable',
      'HIGH',
    );
  }

  const haystack = `${story.title} ${story.userStory} ${story.description}`.toLowerCase();
  const technical = TECHNICAL_TERMS.filter((term) => haystack.includes(term));
  if (technical.length >= 2 && !story.labels.includes('technical')) {
    flag(
      'TECHNICAL_AS_BUSINESS',
      `reads as a technical task rather than a business need (${technical.join(', ')})`,
      'MEDIUM',
    );
  }

  return flags;
}

/**
 * Lexical duplicate detection over titles and user stories. Cheap, deterministic and explainable —
 * embedding similarity is layered on top of this in the BA agent's quality checks, but a similarity
 * score alone is a poor thing to show a human, whereas shared distinctive terms are legible.
 */
export function findDuplicates(stories: StoryLike[], threshold = 0.72): QualityFlag[] {
  const flags: QualityFlag[] = [];
  const tokenised = stories.map((story) => ({
    story,
    tokens: significantTokens(`${story.title} ${story.userStory}`),
  }));

  for (let i = 0; i < tokenised.length; i += 1) {
    for (let j = i + 1; j < tokenised.length; j += 1) {
      const a = tokenised[i]!;
      const b = tokenised[j]!;
      const similarity = jaccard(a.tokens, b.tokens);
      if (similarity >= threshold) {
        const shared = [...a.tokens].filter((token) => b.tokens.has(token)).slice(0, 6);
        flags.push({
          storyRef: b.story.ref,
          kind: 'DUPLICATE',
          detail:
            `${(similarity * 100).toFixed(0)}% overlap with ${a.story.ref} ` +
            `(shared: ${shared.join(', ')})`,
          severity: similarity >= 0.9 ? 'HIGH' : 'MEDIUM',
        });
      }
    }
  }
  return flags;
}

const STOP_WORDS = new Set([
  'a', 'an', 'the', 'as', 'i', 'want', 'so', 'that', 'to', 'be', 'able', 'can', 'of', 'and',
  'or', 'for', 'in', 'on', 'with', 'my', 'is', 'it', 'user', 'able',
]);

function significantTokens(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .split(/\W+/)
      .filter((token) => token.length > 2 && !STOP_WORDS.has(token)),
  );
}

function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let intersection = 0;
  for (const token of a) if (b.has(token)) intersection += 1;
  return intersection / (a.size + b.size - intersection);
}

export interface BacklogReadiness {
  ready: boolean;
  blockingFlags: QualityFlag[];
  warnings: QualityFlag[];
  coverage: { storiesWithCriteria: number; totalStories: number; requirementsCovered: number };
}

/** A backlog is ready when nothing CRITICAL or HIGH remains unresolved. */
export function assessReadiness(
  stories: StoryLike[],
  requirementRefs: string[],
): BacklogReadiness {
  const flags = analyseBacklog(stories);
  const blocking = flags.filter((f) => f.severity === 'CRITICAL' || f.severity === 'HIGH');
  const covered = new Set(stories.flatMap((story) => story.requirementRefs));

  return {
    ready: blocking.length === 0,
    blockingFlags: blocking,
    warnings: flags.filter((f) => f.severity === 'MEDIUM' || f.severity === 'LOW'),
    coverage: {
      storiesWithCriteria: stories.filter((s) => s.acceptanceCriteria.length > 0).length,
      totalStories: stories.length,
      requirementsCovered: requirementRefs.filter((ref) => covered.has(ref)).length,
    },
  };
}
