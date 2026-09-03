/**
 * Projects, discovery, backlog, architecture, estimation and planning endpoints.
 *
 * Commands that affect a workflow return `{ workflowId, runId }` alongside the resource, so a
 * caller can follow the work rather than guess at it.
 */

import {
  BadRequestException,
  Body,
  Controller,
  Get,
  NotFoundException,
  Param,
  Patch,
  Post,
  Query,
  Inject,
} from '@nestjs/common';
import { z } from 'zod';
import { assessReadiness, type StoryLike } from '@sdlc/domain';
import { ConfigService, PrismaService, TemporalService } from './core.js';

const CreateProject = z.object({
  key: z.string().regex(/^[A-Z][A-Z0-9]{1,9}$/, 'key must be 2-10 uppercase characters'),
  name: z.string().min(1),
  description: z.string().optional(),
  repositories: z
    .array(
      z.object({
        key: z.string(),
        role: z.enum(['FRONTEND', 'BACKEND', 'MOBILE', 'INFRA', 'SHARED', 'DOCS']),
        url: z.string(),
        provider: z.enum(['GITHUB', 'GITLAB', 'BITBUCKET', 'LOCAL', 'MOCK']).default('MOCK'),
      }),
    )
    .default([]),
});

const ImportDocument = z.object({
  kind: z.enum([
    'MEETING_TRANSCRIPT',
    'MEETING_NOTES',
    'EMAIL',
    'SPECIFICATION',
    'RESEARCH',
    'CONVERSATION',
    'OTHER',
  ]),
  title: z.string().min(1),
  content: z.string().min(1),
  occurredAt: z.string().datetime().optional(),
  participants: z.array(z.string()).default([]),
});

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function parse<S extends z.ZodTypeAny>(schema: S, body: unknown): z.output<S> {
  const result = schema.safeParse(body);
  if (!result.success) {
    throw new BadRequestException({
      type: 'VALIDATION_ERROR',
      errors: result.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
    });
  }
  return result.data;
}

@Controller('api/v1/projects')
export class ProjectsController {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(TemporalService) private readonly temporal: TemporalService,
    @Inject(ConfigService) private readonly config: ConfigService,
  ) {}

  private get db() {
    return this.prisma.client;
  }

  @Get()
  async list() {
    const projects = await this.db.project.findMany({
      include: { repositories: true, _count: { select: { stories: true, requirements: true } } },
      orderBy: { createdAt: 'desc' },
    });
    return { data: projects };
  }

  @Post()
  async create(@Body() body: unknown) {
    const input = parse(CreateProject, body);

    const project = await this.db.project.create({
      data: {
        key: input.key,
        name: input.name,
        ...(input.description ? { description: input.description } : {}),
        repositories: { create: input.repositories },
        approvalGates: {
          // Gates come from configuration, and every one is enabled with autoApprove off.
          create: Object.entries(this.config.config.workflows.approvalGates).map(([key, gate]) => ({
            key: key as 'BACKLOG',
            enabled: gate.enabled,
            requiredRole: gate.requiredRole,
            timeoutHours: gate.timeoutHours,
            autoApprove: gate.autoApprove,
          })),
        },
      },
      include: { repositories: true, approvalGates: true },
    });

    return { data: project };
  }

  @Get(':id')
  async detail(@Param('id') id: string) {
    const project = await this.db.project.findFirst({
      where: { OR: [{ id }, { key: id }] },
      include: {
        repositories: true,
        integrations: true,
        approvalGates: true,
        _count: {
          select: {
            documents: true,
            requirements: true,
            stories: true,
            architectureOptions: true,
            adrs: true,
            estimates: true,
            pullRequests: true,
            testCases: true,
            bugs: true,
            agentRuns: true,
          },
        },
      },
    });
    if (!project) throw new NotFoundException(`project ${id} not found`);
    return { data: project };
  }

  /** The doc-52 visual pipeline: one row per stage with its state and counts. */
  @Get(':id/pipeline')
  async pipeline(@Param('id') id: string) {
    const project = await this.resolve(id);

    const [documents, requirements, stories, options, adrs, estimates, prs, testCases, bugs, pending] =
      await Promise.all([
        this.db.sourceDocument.count({ where: { projectId: project.id } }),
        this.db.requirement.count({ where: { projectId: project.id } }),
        this.db.story.groupBy({ by: ['status'], where: { projectId: project.id }, _count: true }),
        this.db.architectureOption.count({ where: { projectId: project.id } }),
        this.db.adr.count({ where: { projectId: project.id } }),
        this.db.estimate.count({ where: { projectId: project.id } }),
        this.db.pullRequest.count({ where: { projectId: project.id } }),
        this.db.testCase.count({ where: { projectId: project.id } }),
        this.db.bug.count({ where: { projectId: project.id, status: { not: 'VERIFIED' } } }),
        this.db.approvalRequest.findMany({
          where: { projectId: project.id, status: 'PENDING' },
          select: { id: true, gateKey: true, title: true, requiredRole: true, expiresAt: true },
        }),
      ]);

    const storyCounts = Object.fromEntries(stories.map((s) => [s.status, s._count]));
    const total = stories.reduce((sum, s) => sum + s._count, 0);

    const stage = (name: string, done: boolean, active: boolean, detail: string) => ({
      name,
      state: done ? 'DONE' : active ? 'ACTIVE' : 'PENDING',
      detail,
    });

    const phase = project.phase;
    const reached = (target: string): boolean => PHASE_ORDER.indexOf(phase) > PHASE_ORDER.indexOf(target);

    return {
      data: {
        phase,
        pendingApprovals: pending,
        stages: [
          stage('Discovery', reached('DISCOVERY'), phase === 'DISCOVERY', `${documents} document(s)`),
          stage('Requirements', requirements > 0, phase === 'REQUIREMENTS', `${requirements} requirement(s)`),
          stage(
            'Backlog',
            reached('BACKLOG_APPROVED'),
            ['BACKLOG_DRAFT', 'BACKLOG_REVIEW'].includes(phase),
            `${total} stories (${storyCounts.APPROVED ?? 0} approved)`,
          ),
          stage('Architecture', adrs > 0, phase === 'ARCHITECTURE', `${options} option(s), ${adrs} ADR(s)`),
          stage('Estimation', estimates > 0, phase === 'ESTIMATION', `${estimates} estimate(s)`),
          stage('Planning', reached('PLANNING'), phase === 'PLANNING', 'delivery plan'),
          stage(
            'Development',
            (storyCounts.DONE ?? 0) === total && total > 0,
            phase === 'IN_DEVELOPMENT',
            `${prs} PR(s), ${storyCounts.DONE ?? 0}/${total} stories done`,
          ),
          stage('QA', testCases > 0 && bugs === 0, phase === 'IN_QA', `${testCases} test case(s), ${bugs} open bug(s)`),
          stage('Release', phase === 'COMPLETED', phase === 'RELEASE', ''),
        ],
      },
    };
  }

  /** Cost and quota rollup — docs/45. Subscription and local usage get their own columns. */
  @Get(':id/cost')
  async cost(@Param('id') id: string) {
    const project = await this.resolve(id);
    const runs = await this.db.agentRun.findMany({
      where: { projectId: project.id },
      select: { agentKey: true, totalCostUsd: true, totalTokens: true, llmCalls: { select: { billingMode: true, quotaUnits: true, costUnknown: true } } },
    });

    const byAgent = new Map<
      string,
      { runs: number; costUsd: number; tokens: number; quotaUnits: number; costUnknown: boolean }
    >();

    for (const run of runs) {
      const entry = byAgent.get(run.agentKey) ?? {
        runs: 0,
        costUsd: 0,
        tokens: 0,
        quotaUnits: 0,
        costUnknown: false,
      };
      entry.runs += 1;
      entry.costUsd += run.totalCostUsd;
      entry.tokens += run.totalTokens;
      for (const call of run.llmCalls) {
        entry.quotaUnits += call.quotaUnits;
        if (call.costUnknown) entry.costUnknown = true;
      }
      byAgent.set(run.agentKey, entry);
    }

    const rows = [...byAgent.entries()].map(([agentKey, entry]) => ({ agentKey, ...entry }));
    return {
      data: {
        rows,
        total: {
          runs: rows.reduce((s, r) => s + r.runs, 0),
          costUsd: Number(rows.reduce((s, r) => s + r.costUsd, 0).toFixed(4)),
          tokens: rows.reduce((s, r) => s + r.tokens, 0),
          quotaUnits: rows.reduce((s, r) => s + r.quotaUnits, 0),
          // Reported explicitly rather than folded into a total that would look complete.
          costUnknown: rows.some((r) => r.costUnknown),
        },
        budgetUsd: this.config.env.MAX_WORKFLOW_COST_USD,
      },
    };
  }

  /** The doc-68 trace: every artifact back to the sentence that produced it. */
  @Get(':id/trace')
  async trace(@Param('id') id: string) {
    const project = await this.resolve(id);

    const rows = await this.db.$queryRawUnsafe<
      { document: string; requirement: string; story: string; testCase: string | null }[]
    >(
      `SELECT d.title AS document, r.ref AS requirement, s.ref AS story, tc.ref AS "testCase"
         FROM requirements r
         JOIN source_documents d ON d.id::text = (r."sourceRefs"->0->>'documentId')
         LEFT JOIN story_requirements sr ON sr."requirementId" = r.id
         LEFT JOIN stories s ON s.id = sr."storyId"
         LEFT JOIN test_cases tc ON tc."storyId" = s.id
        WHERE r."projectId" = $1
        ORDER BY r.ref, s.ref, tc.ref`,
      project.id,
    );

    return { data: rows };
  }

  // ── discovery ──────────────────────────────────────────────────────────

  @Get(':id/documents')
  async documents(@Param('id') id: string) {
    const project = await this.resolve(id);
    return {
      data: await this.db.sourceDocument.findMany({
        where: { projectId: project.id },
        select: { id: true, kind: true, title: true, occurredAt: true, ingestedAt: true, participants: true },
        orderBy: { occurredAt: 'asc' },
      }),
    };
  }

  @Post(':id/documents')
  async importDocument(@Param('id') id: string, @Body() body: unknown) {
    const project = await this.resolve(id);
    const input = parse(ImportDocument, body);
    const { createHash } = await import('node:crypto');
    const contentSha = createHash('sha256').update(input.content).digest('hex');

    const document = await this.db.sourceDocument.upsert({
      where: { projectId_contentSha: { projectId: project.id, contentSha } },
      create: {
        projectId: project.id,
        kind: input.kind,
        title: input.title,
        content: input.content,
        contentSha,
        ...(input.occurredAt ? { occurredAt: new Date(input.occurredAt) } : {}),
        participants: input.participants,
      },
      update: {},
    });
    return { data: document };
  }

  // ── requirements & backlog ─────────────────────────────────────────────

  @Get(':id/requirements')
  async requirements(@Param('id') id: string, @Query('type') type?: string) {
    const project = await this.resolve(id);
    return {
      data: await this.db.requirement.findMany({
        where: { projectId: project.id, ...(type ? { type: type as 'FUNCTIONAL' } : {}) },
        orderBy: { ref: 'asc' },
      }),
    };
  }

  @Get(':id/stories')
  async stories(@Param('id') id: string, @Query('status') status?: string) {
    const project = await this.resolve(id);
    return {
      data: await this.db.story.findMany({
        where: { projectId: project.id, ...(status ? { status: status as 'APPROVED' } : {}) },
        include: {
          acceptanceCriteria: { orderBy: { orderIndex: 'asc' } },
          qualityFlags: { where: { resolved: false } },
          epic: true,
          estimates: true,
          requirementLinks: { include: { requirement: { select: { ref: true } } } },
        },
        orderBy: [{ orderIndex: 'asc' }, { ref: 'asc' }],
      }),
    };
  }

  @Patch(':id/stories/:storyId')
  async editStory(@Param('storyId') storyId: string, @Body() body: Record<string, unknown>) {
    const allowed = ['title', 'description', 'userStory', 'businessValue', 'priority', 'sizeSignal'];
    const data = Object.fromEntries(Object.entries(body).filter(([key]) => allowed.includes(key)));
    return { data: await this.db.story.update({ where: { id: storyId }, data }) };
  }

  @Post(':id/stories/:storyId/:action')
  async storyAction(@Param('storyId') storyId: string, @Param('action') action: string) {
    const map: Record<string, 'APPROVED' | 'REJECTED' | 'CHANGES_REQUESTED'> = {
      approve: 'APPROVED',
      reject: 'REJECTED',
      'request-changes': 'CHANGES_REQUESTED',
    };
    const status = map[action];
    if (!status) throw new BadRequestException(`unknown action: ${action}`);
    return { data: await this.db.story.update({ where: { id: storyId }, data: { status } }) };
  }

  /** Backlog quality: the platform's own analysis, not just the BA's self-report. */
  @Get(':id/backlog/quality')
  async backlogQuality(@Param('id') id: string) {
    const project = await this.resolve(id);
    const stories = await this.db.story.findMany({
      where: { projectId: project.id, status: { not: 'REJECTED' } },
      include: {
        acceptanceCriteria: true,
        requirementLinks: { include: { requirement: { select: { ref: true } } } },
      },
    });
    const requirements = await this.db.requirement.findMany({
      where: { projectId: project.id },
      select: { ref: true },
    });

    const asStoryLike: StoryLike[] = stories.map((story) => ({
      ref: story.ref,
      title: story.title,
      userStory: story.userStory,
      description: story.description,
      sizeSignal: story.sizeSignal,
      acceptanceCriteria: story.acceptanceCriteria.map((criterion) => ({
        kind: criterion.kind,
        given: criterion.given,
        when: criterion.whenText,
        then: criterion.thenText,
        statement: criterion.statement,
      })),
      edgeCases: (story.edgeCases as string[]) ?? [],
      requirementRefs: story.requirementLinks.map((link) => link.requirement.ref),
      labels: story.labels,
    }));

    return { data: assessReadiness(asStoryLike, requirements.map((r) => r.ref)) };
  }

  // ── architecture, estimation, planning ─────────────────────────────────

  @Get(':id/architecture')
  async architecture(@Param('id') id: string) {
    const project = await this.resolve(id);
    const [options, recommendation, adrs] = await Promise.all([
      this.db.architectureOption.findMany({
        where: { projectId: project.id },
        include: { evaluations: true },
        orderBy: { variant: 'asc' },
      }),
      this.db.architectureRecommendation.findFirst({
        where: { projectId: project.id },
        orderBy: { createdAt: 'desc' },
      }),
      this.db.adr.findMany({ where: { projectId: project.id }, orderBy: { number: 'asc' } }),
    ]);
    return { data: { options, recommendation, adrs } };
  }

  @Get(':id/estimates')
  async estimates(@Param('id') id: string) {
    const project = await this.resolve(id);
    const [estimates, reviews] = await Promise.all([
      this.db.estimate.findMany({
        where: { projectId: project.id },
        include: { story: { select: { ref: true, title: true } } },
      }),
      this.db.estimateReview.findMany({
        where: { projectId: project.id },
        include: { story: { select: { ref: true } } },
      }),
    ]);
    return { data: { estimates, reviews } };
  }

  @Get(':id/plan')
  async plan(@Param('id') id: string) {
    const project = await this.resolve(id);
    const [resources, delivery] = await Promise.all([
      this.db.resourcePlan.findFirst({
        where: { projectId: project.id },
        orderBy: { version: 'desc' },
        include: { allocations: true },
      }),
      this.db.deliveryPlan.findFirst({
        where: { projectId: project.id },
        orderBy: { version: 'desc' },
        include: { milestones: { orderBy: { orderIndex: 'asc' } } },
      }),
    ]);
    return { data: { resources, delivery } };
  }

  @Get(':id/pull-requests')
  async pullRequests(@Param('id') id: string) {
    const project = await this.resolve(id);
    return {
      data: await this.db.pullRequest.findMany({
        where: { projectId: project.id },
        include: {
          story: { select: { ref: true, title: true } },
          reviews: { include: { comments: true } },
        },
        orderBy: { createdAt: 'desc' },
      }),
    };
  }

  @Get(':id/qa')
  async qa(@Param('id') id: string) {
    const project = await this.resolve(id);
    const [testCases, runs, bugs] = await Promise.all([
      this.db.testCase.findMany({
        where: { projectId: project.id },
        include: { story: { select: { ref: true } } },
        orderBy: { ref: 'asc' },
      }),
      this.db.testRun.findMany({
        where: { projectId: project.id },
        include: { results: { include: { evidence: true, testCase: { select: { ref: true } } } } },
        orderBy: { startedAt: 'desc' },
        take: 10,
      }),
      this.db.bug.findMany({ where: { projectId: project.id }, orderBy: { ref: 'asc' } }),
    ]);
    return { data: { testCases, runs, bugs } };
  }

  // ── workflow control ───────────────────────────────────────────────────

  @Post(':id/start')
  async start(@Param('id') id: string) {
    const project = await this.resolve(id);
    const repository = await this.db.projectRepository.findFirst({ where: { projectId: project.id } });
    const env = this.config.env;

    const handle = await this.temporal.client.workflow.start('ProjectWorkflow', {
      taskQueue: env.TEMPORAL_TASK_QUEUE_MAIN,
      workflowId: `project-${project.key}`,
      args: [
        {
          projectId: project.id,
          projectKey: project.key,
          repositoryKey: repository?.key ?? 'api',
          limits: {
            maxBacklogRevisions: env.MAX_BACKLOG_REVISIONS,
            maxArchitectureRounds: env.MAX_ARCHITECTURE_ROUNDS,
            maxPrFixIterations: env.MAX_PR_FIX_ITERATIONS,
            maxQaFixIterations: env.MAX_QA_FIX_ITERATIONS,
            maxBuildFixIterations: env.MAX_BUILD_FIX_ITERATIONS,
            maxParallelStories: env.MAX_PARALLEL_STORIES,
            maxWorkflowCostUsd: env.MAX_WORKFLOW_COST_USD,
            estimationVarianceThreshold: env.ESTIMATION_VARIANCE_THRESHOLD,
            approvalDefaultTimeoutHours: env.APPROVAL_DEFAULT_TIMEOUT_HOURS,
          },
        },
      ],
    });

    return { data: { workflowId: handle.workflowId, runId: handle.firstExecutionRunId } };
  }

  @Post(':id/:command')
  async command(@Param('id') id: string, @Param('command') command: string) {
    const project = await this.resolve(id);
    const signals: Record<string, string> = {
      pause: 'pauseProject',
      resume: 'resumeProject',
      cancel: 'cancelProject',
    };
    const signal = signals[command];
    if (!signal) throw new BadRequestException(`unknown command: ${command}`);

    await this.temporal.client.workflow.getHandle(`project-${project.key}`).signal(signal);
    return { data: { signalled: signal } };
  }

  private async resolve(id: string) {
    const project = await this.db.project.findFirst({ where: { OR: [{ id }, { key: id }] } });
    if (!project) throw new NotFoundException(`project ${id} not found`);
    return project;
  }
}

const PHASE_ORDER = [
  'DISCOVERY',
  'REQUIREMENTS',
  'BACKLOG_DRAFT',
  'BACKLOG_REVIEW',
  'BACKLOG_APPROVED',
  'ARCHITECTURE',
  'ARCHITECTURE_APPROVED',
  'ESTIMATION',
  'PLANNING',
  'READY_FOR_DEVELOPMENT',
  'IN_DEVELOPMENT',
  'IN_QA',
  'RELEASE',
  'COMPLETED',
];
