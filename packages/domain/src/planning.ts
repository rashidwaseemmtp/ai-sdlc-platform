/**
 * Delivery planning maths — pure, so workflows can rely on it through an activity and tests can
 * cover it without a database.
 */

export interface DagNode {
  ref: string;
  /** Refs this node depends on — it cannot start until they are done. */
  dependsOn: string[];
  estimateHours?: number;
  priority?: 'MUST' | 'SHOULD' | 'COULD' | 'WONT';
}

export interface Wave {
  index: number;
  refs: string[];
}

export interface TopologyResult {
  waves: Wave[];
  /** Refs involved in a dependency cycle. Non-empty means the plan is not executable. */
  cycles: string[][];
  criticalPath: { refs: string[]; hours: number };
  orphans: string[];
}

/**
 * Group stories into dependency waves. Everything in a wave can run in parallel; wave *n+1* waits
 * for wave *n*. This is what `DevelopmentWorkflow` fans out over.
 *
 * Cycles are reported, not thrown: a cyclic backlog is a real BA output that a human must fix, and
 * the caller decides whether to park or to plan around it.
 */
export function computeWaves(nodes: DagNode[]): TopologyResult {
  const byRef = new Map(nodes.map((node) => [node.ref, node]));
  const known = new Set(byRef.keys());

  const orphans: string[] = [];
  const indegree = new Map<string, number>();
  const dependents = new Map<string, string[]>();

  for (const node of nodes) {
    const deps = node.dependsOn.filter((dep) => {
      if (known.has(dep)) return true;
      orphans.push(`${node.ref} -> ${dep}`);
      return false;
    });
    indegree.set(node.ref, deps.length);
    for (const dep of deps) {
      dependents.set(dep, [...(dependents.get(dep) ?? []), node.ref]);
    }
  }

  const waves: Wave[] = [];
  const settled = new Set<string>();
  let frontier = nodes
    .filter((node) => (indegree.get(node.ref) ?? 0) === 0)
    .map((node) => node.ref)
    .sort(compareRefs(byRef));

  while (frontier.length > 0) {
    waves.push({ index: waves.length, refs: frontier });
    for (const ref of frontier) settled.add(ref);

    const next: string[] = [];
    for (const ref of frontier) {
      for (const dependent of dependents.get(ref) ?? []) {
        const remaining = (indegree.get(dependent) ?? 0) - 1;
        indegree.set(dependent, remaining);
        if (remaining === 0) next.push(dependent);
      }
    }
    frontier = [...new Set(next)].sort(compareRefs(byRef));
  }

  const unsettled = nodes.filter((node) => !settled.has(node.ref)).map((node) => node.ref);
  const cycles = unsettled.length ? findCycles(byRef, unsettled) : [];

  return { waves, cycles, criticalPath: criticalPath(byRef), orphans };
}

/** Longest dependency chain by estimated hours — the floor on delivery duration. */
function criticalPath(byRef: Map<string, DagNode>): { refs: string[]; hours: number } {
  const memo = new Map<string, { refs: string[]; hours: number }>();
  const visiting = new Set<string>();

  const walk = (ref: string): { refs: string[]; hours: number } => {
    const cached = memo.get(ref);
    if (cached) return cached;
    if (visiting.has(ref)) return { refs: [], hours: 0 }; // cycle guard
    visiting.add(ref);

    const node = byRef.get(ref);
    const own = node?.estimateHours ?? 0;
    let best: { refs: string[]; hours: number } = { refs: [], hours: 0 };

    for (const dep of node?.dependsOn ?? []) {
      if (!byRef.has(dep)) continue;
      const candidate = walk(dep);
      if (candidate.hours > best.hours) best = candidate;
    }

    visiting.delete(ref);
    const result = { refs: [...best.refs, ref], hours: best.hours + own };
    memo.set(ref, result);
    return result;
  };

  let longest: { refs: string[]; hours: number } = { refs: [], hours: 0 };
  for (const ref of byRef.keys()) {
    const candidate = walk(ref);
    if (candidate.hours > longest.hours) longest = candidate;
  }
  return longest;
}

function findCycles(byRef: Map<string, DagNode>, candidates: string[]): string[][] {
  const cycles: string[][] = [];
  const stack: string[] = [];
  const onStack = new Set<string>();
  const visited = new Set<string>();

  const visit = (ref: string): void => {
    if (onStack.has(ref)) {
      cycles.push([...stack.slice(stack.indexOf(ref)), ref]);
      return;
    }
    if (visited.has(ref)) return;
    visited.add(ref);
    onStack.add(ref);
    stack.push(ref);

    for (const dep of byRef.get(ref)?.dependsOn ?? []) {
      if (byRef.has(dep)) visit(dep);
    }

    stack.pop();
    onStack.delete(ref);
  };

  for (const ref of candidates) visit(ref);
  return cycles;
}

/** MUST first, then larger stories, then ref — deterministic so replays are stable. */
function compareRefs(byRef: Map<string, DagNode>) {
  const priorityRank: Record<string, number> = { MUST: 0, SHOULD: 1, COULD: 2, WONT: 3 };
  return (a: string, b: string): number => {
    const nodeA = byRef.get(a);
    const nodeB = byRef.get(b);
    const byPriority =
      (priorityRank[nodeA?.priority ?? 'SHOULD'] ?? 1) - (priorityRank[nodeB?.priority ?? 'SHOULD'] ?? 1);
    if (byPriority !== 0) return byPriority;
    const bySize = (nodeB?.estimateHours ?? 0) - (nodeA?.estimateHours ?? 0);
    if (bySize !== 0) return bySize;
    return a.localeCompare(b);
  };
}

export interface MilestoneSuggestion {
  name: string;
  refs: string[];
  hours: number;
}

/** Group waves into milestones under an hours cap, so a plan has reviewable checkpoints. */
export function suggestMilestones(
  waves: Wave[],
  hoursByRef: Record<string, number>,
  maxHoursPerMilestone = 80,
): MilestoneSuggestion[] {
  const milestones: MilestoneSuggestion[] = [];
  let current: MilestoneSuggestion = { name: 'Milestone 1', refs: [], hours: 0 };

  for (const wave of waves) {
    const waveHours = wave.refs.reduce((sum, ref) => sum + (hoursByRef[ref] ?? 0), 0);
    if (current.refs.length && current.hours + waveHours > maxHoursPerMilestone) {
      milestones.push(current);
      current = { name: `Milestone ${milestones.length + 1}`, refs: [], hours: 0 };
    }
    current.refs.push(...wave.refs);
    current.hours += waveHours;
  }

  if (current.refs.length) milestones.push(current);
  return milestones;
}
