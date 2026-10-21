/**
 * Fleet S5b workspace tools US-002 (S5b-R7) — the executor's `project` argument against PG, with the real koda tools.
 * Run: cd apps/api && bun run test:db:up && bun run test:scoped test/integration/fleet/assistant-workspace-project-argument.integration.spec.ts
 */
import { NathApplication } from '@nathapp/nestjs-app';
import { PrismaService } from '@nathapp/nestjs-prisma';
import { Prisma, PrismaClient } from '../../../src/generated/prisma/client';
import { AssistantToolExecutor } from '../../../src/fleet/assistant/assistant-tool.executor';
import { MembershipService } from '../../../src/permissions/membership.service';
import { resetDb } from '../../helpers/reset-db';
import { bootHttpApp } from '../../helpers/http-app';
import { seedFleetBase } from '../../helpers/fleet-fixtures';

const describeIntegration = process.env.KODA_DB_TESTS === '1' ? describe : describe.skip;

describeIntegration('AssistantToolExecutor project argument in WORKSPACE threads (PG, S5b-R7)', () => {
  let app: NathApplication;
  let prisma: PrismaClient;
  let executor: AssistantToolExecutor;
  let homeId: string;
  let bId: string;
  let creatorId: string;
  let creatorJobId: string;
  let adminJobId: string;
  let sharedRepoId: string;
  let seq = 0;

  async function workspaceJob(base: { repoId: string }, userId: string): Promise<string> {
    const thread = await prisma.chatThread.create({ data: {
      kind: 'WORKSPACE', projectId: homeId, title: 'ws', createdById: userId, backend: { type: 'native' } as Prisma.InputJsonValue, skills: [],
    } });
    const job = await prisma.fleetJob.create({ data: {
      projectId: homeId, repoId: base.repoId, ref: 'main', command: 'THREAD', feature: `t-${thread.id}`, profiles: [],
      maxCostUsd: new Prisma.Decimal(1), selectorLabels: [], requestedById: userId, threadId: thread.id, state: 'RUNNING',
    } });
    return job.id;
  }

  const call = (jobId: string, name: string, input: unknown) => executor.execute({ jobId, toolCallId: `c${++seq}`, name, input });

  beforeAll(async () => {
    await resetDb();
    app = await bootHttpApp({ registrationEnabled: false });
    prisma = app.get<PrismaService<PrismaClient>>(PrismaService).client;
    executor = app.get(AssistantToolExecutor, { strict: false });
    const base = await seedFleetBase(prisma);
    homeId = base.projectId;
    sharedRepoId = base.repoId;
    const b = await prisma.project.create({ data: { name: 'b', slug: 'b', key: 'B' } });
    bId = b.id;
    await prisma.project.create({ data: { name: 'c', slug: 'c', key: 'C' } });
    const gone = await prisma.project.create({ data: { name: 'gone', slug: 'gone', key: 'GONE', deletedAt: new Date() } });
    const creator = await prisma.user.create({ data: { email: 'ws-creator@koda.test', passwordHash: 'x', role: 'MEMBER' } });
    creatorId = creator.id;
    await prisma.projectMember.createMany({ data: [
      { projectId: bId, userId: creatorId, role: 'DEVELOPER' },
      { projectId: gone.id, userId: creatorId, role: 'DEVELOPER' },
    ] });
    await prisma.ticket.create({ data: { projectId: bId, number: 1, type: 'TASK', title: 'b ticket', createdByUserId: creatorId } });
    await prisma.fleetJob.create({ data: {
      projectId: bId, repoId: sharedRepoId, ref: 'main', command: 'RUN', feature: 'job-in-b', profiles: [],
      maxCostUsd: new Prisma.Decimal(1), selectorLabels: [], requestedById: creatorId, state: 'FAILED',
    } });
    await prisma.fleetJob.create({ data: {
      projectId: homeId, repoId: sharedRepoId, ref: 'main', command: 'RUN', feature: 'job-in-home', profiles: [],
      maxCostUsd: new Prisma.Decimal(1), selectorLabels: [], requestedById: creatorId, state: 'FAILED',
    } });
    creatorJobId = await workspaceJob(base, creatorId);
    adminJobId = await workspaceJob(base, base.adminId);
  }, 60_000);

  afterAll(async () => {
    await app?.close();
  });

  it('AC-6 and AC-7: a DEVELOPER of b reads b ticket B-1, and the audit row names b', async () => {
    const result = await executor.execute({ jobId: creatorJobId, toolCallId: 'ac6', name: 'koda_get_ticket', input: { project: 'b', ref: 'B-1' } });
    expect(result.isError).toBe(false);
    expect(result.content).toContain('/b/tickets/B-1');
    const row = await prisma.assistantToolCall.findUnique({ where: { jobId_toolCallId: { jobId: creatorJobId, toolCallId: 'ac6' } } });
    expect(row?.projectId).toBe(bId);
  });

  it('AC-8: koda_list_jobs with project b names the job of b and not the job of the home project', async () => {
    const result = await call(creatorJobId, 'koda_list_jobs', { project: 'b' });
    expect(result.isError).toBe(false);
    expect(result.content).toContain('job-in-b');
    expect(result.content).not.toContain('job-in-home');
  });

  it('AC-9: a project the creator is not a member of answers not_found: project, audited on the home project', async () => {
    const result = await executor.execute({ jobId: creatorJobId, toolCallId: 'ac9', name: 'koda_search_tickets', input: { project: 'c' } });
    expect(result).toEqual({ content: 'not_found: project', isError: true });
    const row = await prisma.assistantToolCall.findUnique({ where: { jobId_toolCallId: { jobId: creatorJobId, toolCallId: 'ac9' } } });
    expect(row).toMatchObject({ projectId: homeId, outcome: 'not_found' });
  });

  it('AC-10: an unknown slug answers not_found: project', async () => {
    expect(await call(creatorJobId, 'koda_search_tickets', { project: 'nope' })).toEqual({ content: 'not_found: project', isError: true });
  });

  it('AC-11: a soft-deleted project the creator was a member of answers not_found: project', async () => {
    expect(await call(creatorJobId, 'koda_search_tickets', { project: 'gone' })).toEqual({ content: 'not_found: project', isError: true });
  });

  it('AC-12: a global ADMIN with no member row reaches project c', async () => {
    expect((await call(adminJobId, 'koda_search_tickets', { project: 'c' })).isError).toBe(false);
  });

  it('AC-13: after the creator is removed from b, the same call answers not_found: project', async () => {
    const extra = await prisma.user.create({ data: { email: 'ws-removed@koda.test', passwordHash: 'x', role: 'MEMBER' } });
    const jobId = await workspaceJob({ repoId: sharedRepoId }, extra.id);
    await prisma.projectMember.create({ data: { projectId: bId, userId: extra.id, role: 'DEVELOPER' } });
    await app.get(MembershipService).invalidatePermissions();
    expect((await call(jobId, 'koda_search_tickets', { project: 'b' })).isError).toBe(false);
    await prisma.projectMember.deleteMany({ where: { projectId: bId, userId: extra.id } });
    // US-001: access is decided from the effective-permission cache, so the row removal needs an invalidation
    // before the next call sees it.
    await app.get(MembershipService).invalidatePermissions();
    expect(await call(jobId, 'koda_search_tickets', { project: 'b' })).toEqual({ content: 'not_found: project', isError: true });
  });
});
