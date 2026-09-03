/**
 * Seed — users, the demo project, and its discovery material.
 *
 * The demo project is the doc-66 requirement: a developer should be able to start the platform and
 * watch the entire pipeline without configuring GitHub, Figma, Jira or a model provider.
 *
 * Idempotent: running it twice changes nothing.
 */

import { getPrisma, disconnectPrisma } from './index.js';
import { createHash } from 'node:crypto';

const prisma = getPrisma();

const sha = (text: string): string => createHash('sha256').update(text).digest('hex');

const MEETING_NOTES = `# Discovery call — Customer Management SaaS
Date: 12 March
Present: Head of Support, Finance Manager, CTO, delivery team

## Context
Customer data lives in three places today: a CRM the sales team owns, a billing spreadsheet finance
maintains by hand, and a shared mailbox. Nobody can answer a customer billing question without
checking all three, and the answers disagree often enough that support has stopped trusting the CRM.

## What they asked for
The CTO framed it as "one record per customer that support can actually rely on". Concretely:

- Administrators need to create, view, edit and search customer records. Search is used constantly,
  so it has to be fast — the Head of Support said anything over about half a second feels broken.
- Administrators need to deactivate a customer account when they leave. Today this is a manual
  process involving three systems and it gets forgotten.
- Support agents should see a customer's invoice history, but must not be able to change it.
  The Finance Manager was firm about this.

## The rule finance cares about
The Finance Manager raised this twice: a customer with outstanding unpaid invoices must not be
deactivated, because deactivation currently revokes the portal access they need to pay. She wants a
hard block, not a warning. There is apparently an override for exceptional cases, but she was not
sure who is allowed to authorise it — she will check with the CFO.

## Audit
Every lifecycle change needs an audit trail. The CTO said 24 months of retention; when asked whether
that was regulatory or a preference he said he would confirm.

## Constraints
- Must run on the existing PostgreSQL and Node.js estate. No new database technology.
- First release needed within one quarter.
- Roughly 8,000 customers today, expected to roughly double over two years.

## Open concerns
The delivery team asked about migrating the legacy spreadsheet. Nobody has profiled its data
quality. The CTO acknowledged this is probably the biggest unknown in the project.
`;

const FOLLOW_UP_EMAIL = `Subject: Re: Customer Management — a couple of clarifications
From: Head of Support

Two things after yesterday's call.

First, when an administrator tries to deactivate a customer who has unpaid invoices, please make the
error message list which invoices are outstanding. Today our agents have to go and look them up
separately, and that is most of the handling time.

Second, deactivation needs to be immediate. If someone deactivates an account, that customer should
not be able to log in on the next request — not after a nightly job.

One more thing I forgot to mention: two administrators sometimes act on the same customer at the
same time. It has caused duplicate records before. Whatever you build should handle that properly.
`;

async function main(): Promise<void> {
  // ── users ──────────────────────────────────────────────────────────────
  const users = [
    { email: 'admin@example.com', name: 'Platform Admin', role: 'ADMIN' as const },
    { email: 'product@example.com', name: 'Priya (Product)', role: 'PRODUCT' as const },
    { email: 'architect@example.com', name: 'Alex (Architect)', role: 'ARCHITECT' as const },
    { email: 'engineer@example.com', name: 'Erin (Engineer)', role: 'ENGINEER' as const },
    { email: 'qa@example.com', name: 'Quinn (QA)', role: 'QA' as const },
  ];

  const created = [];
  for (const user of users) {
    created.push(
      await prisma.user.upsert({
        where: { email: user.email },
        create: user,
        update: { name: user.name, role: user.role },
      }),
    );
  }

  // ── demo project ───────────────────────────────────────────────────────
  const project = await prisma.project.upsert({
    where: { key: 'CMS' },
    create: {
      key: 'CMS',
      name: 'Customer Management SaaS',
      description:
        'Consolidates customer records, subscriptions and invoices into one system support and ' +
        'finance can both rely on.',
      status: 'ACTIVE',
      phase: 'DISCOVERY',
      settings: {
        techStack: { backend: 'NestJS', frontend: 'Next.js', db: 'PostgreSQL' },
        integrations: { product: 'local', ba: 'local', vcs: 'mock', design: 'mock', testing: 'mock' },
      },
    },
    update: {},
  });

  for (const user of created) {
    await prisma.projectMember.upsert({
      where: { projectId_userId: { projectId: project.id, userId: user.id } },
      create: { projectId: project.id, userId: user.id, role: user.role },
      update: {},
    });
  }

  await prisma.projectRepository.upsert({
    where: { projectId_key: { projectId: project.id, key: 'api' } },
    create: {
      projectId: project.id,
      key: 'api',
      role: 'BACKEND',
      provider: 'MOCK',
      url: 'https://mock.github/acme/cms-api',
      defaultBranch: 'main',
      branchPattern: '^(feat|fix|chore)/[A-Z]+-\\d+',
      protectedBranches: ['main', 'master', 'develop'],
    },
    update: {},
  });

  await prisma.projectRepository.upsert({
    where: { projectId_key: { projectId: project.id, key: 'web' } },
    create: {
      projectId: project.id,
      key: 'web',
      role: 'FRONTEND',
      provider: 'MOCK',
      url: 'https://mock.github/acme/cms-web',
      defaultBranch: 'main',
    },
    update: {},
  });

  for (const integration of [
    { kind: 'PRODUCT' as const, serverKey: 'product' },
    { kind: 'BA' as const, serverKey: 'ba' },
    { kind: 'VCS' as const, serverKey: 'github' },
    { kind: 'DESIGN' as const, serverKey: 'figma', externalRef: 'demo-figma-file' },
    { kind: 'TESTING' as const, serverKey: 'playwright' },
  ]) {
    await prisma.projectIntegration.upsert({
      where: { projectId_kind: { projectId: project.id, kind: integration.kind } },
      create: { projectId: project.id, ...integration, enabled: true },
      update: {},
    });
  }

  // ── approval gates: every one enabled, none auto-approving ──────────────
  const gates = [
    { key: 'BACKLOG' as const, requiredRole: 'PRODUCT' as const, timeoutHours: 72 },
    { key: 'ARCHITECTURE' as const, requiredRole: 'ARCHITECT' as const, timeoutHours: 72 },
    { key: 'ESTIMATION' as const, requiredRole: 'PRODUCT' as const, timeoutHours: 48 },
    { key: 'DEV_READINESS' as const, requiredRole: 'PRODUCT' as const, timeoutHours: 48 },
    { key: 'PR' as const, requiredRole: 'ENGINEER' as const, timeoutHours: 72 },
    { key: 'QA' as const, requiredRole: 'QA' as const, timeoutHours: 48 },
    { key: 'RELEASE' as const, requiredRole: 'ADMIN' as const, timeoutHours: 168 },
  ];

  for (const gate of gates) {
    await prisma.approvalGate.upsert({
      where: { projectId_key: { projectId: project.id, key: gate.key } },
      create: { projectId: project.id, ...gate, enabled: true, autoApprove: false },
      update: {},
    });
  }

  // ── discovery material ─────────────────────────────────────────────────
  const documents = [
    {
      kind: 'MEETING_NOTES' as const,
      title: 'Discovery call — 12 March',
      content: MEETING_NOTES,
      occurredAt: new Date('2026-03-12T10:00:00Z'),
      participants: ['Head of Support', 'Finance Manager', 'CTO'],
    },
    {
      kind: 'EMAIL' as const,
      title: 'Re: Customer Management — clarifications',
      content: FOLLOW_UP_EMAIL,
      occurredAt: new Date('2026-03-13T09:15:00Z'),
      participants: ['Head of Support'],
    },
  ];

  for (const document of documents) {
    await prisma.sourceDocument.upsert({
      where: { projectId_contentSha: { projectId: project.id, contentSha: sha(document.content) } },
      create: {
        projectId: project.id,
        kind: document.kind,
        title: document.title,
        content: document.content,
        contentSha: sha(document.content),
        occurredAt: document.occurredAt,
        participants: document.participants,
      },
      update: {},
    });
  }

  // ── model providers and catalog, so the dashboard has something to show ──
  await prisma.modelProviderConfig.upsert({
    where: { key: 'mock' },
    create: {
      key: 'mock',
      kind: 'MOCK',
      billingMode: 'LOCAL_FREE',
      enabled: true,
      maxConcurrent: 8,
      healthStatus: 'HEALTHY',
    },
    update: {},
  });

  for (const entry of [
    {
      providerKey: 'mock',
      modelId: 'mock-frontier',
      displayName: 'Mock Frontier',
      tier: 'FRONTIER' as const,
      capabilities: ['HIGH_REASONING', 'CODING', 'STRUCTURED_REASONING', 'STRUCTURED_OUTPUT', 'LONG_CONTEXT', 'TOOL_USE'],
      contextWindow: 1_000_000,
      maxOutput: 64_000,
      billingMode: 'LOCAL_FREE' as const,
      enabled: true,
    },
    {
      providerKey: 'mock',
      modelId: 'mock-small',
      displayName: 'Mock Small',
      tier: 'SMALL' as const,
      capabilities: ['CLASSIFICATION', 'STRUCTURED_OUTPUT', 'TOOL_USE'],
      contextWindow: 200_000,
      maxOutput: 8_000,
      billingMode: 'LOCAL_FREE' as const,
      enabled: true,
    },
  ]) {
    await prisma.modelCatalogEntry.upsert({
      where: { providerKey_modelId: { providerKey: entry.providerKey, modelId: entry.modelId } },
      create: entry,
      update: {},
    });
  }

  const counts = {
    users: created.length,
    project: project.key,
    repositories: 2,
    gates: gates.length,
    documents: documents.length,
  };

  console.log('Seeded:', JSON.stringify(counts, null, 2));
  console.log('\nDemo project ready. Start the pipeline with:');
  console.log('  pnpm demo\n');
}

main()
  .catch((error: unknown) => {
    console.error(error);
    process.exit(1);
  })
  .finally(() => void disconnectPrisma());
