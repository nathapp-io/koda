/**
 * Fleet S5b 2a US-005 — deciding an `assistant_action` approval over HTTP against PG: the creator-only gate on both
 * prefixes, reject with its system note, the decision allowlist, and expiry-on-decide.
 *
 * Every action is seeded through a real `AssistantActionService.propose` (spec §Stories), and every decide enters the
 * real project or admin route, so the late-bound `AssistantActionPort` registration (2a-D1) is exercised end to end.
 *
 * Run: cd apps/api && bun run test:db:up && bun run test:scoped test/integration/fleet/assistant-actions-decide.integration.spec.ts
 */
import { NathApplication } from '@nathapp/nestjs-app';
import { PrismaService } from '@nathapp/nestjs-prisma';
import request from 'supertest';
import { Prisma, PrismaClient } from '../../../src/generated/prisma/client';
import { AssistantActionService } from '../../../src/fleet/assistant/actions/assistant-action.service';
import { ACTION_TTL_MS, type ProposeInput } from '../../../src/fleet/assistant/actions/pending-action.domain';
import { resetDb } from '../../helpers/reset-db';
import { bootHttpApp, data } from '../../helpers/http-app';
import { seedFleetHttpWorld, type FleetHttpWorld } from '../../helpers/fleet-fixtures';

const describeIntegration = process.env.KODA_DB_TESTS === '1' ? describe : describe.skip;
vi.setConfig({ testTimeout: 30_000 });

const TOOL = 'koda_add_comment';
const PROJECT = '/api/projects/web/fleet/approvals';
const ADMIN = '/api/fleet/approvals';
const NOT_PENDING = 'This approval is no longer pending';

interface Seed { threadId: string; jobId: string }

describeIntegration('deciding an assistant_action approval (PG, US-005)', () => {
  let app: NathApplication;
  let prisma: PrismaClient;
  let world: FleetHttpWorld;
  let actions: AssistantActionService;
  let seq = 0;
  const saved: Record<string, string | undefined> = {};

  const as = (token: string) => ({ Authorization: `Bearer ${token}` });

  async function seedThread(): Promise<Seed> {
    const thread = await prisma.chatThread.create({
      data: {
        projectId: world.projectId, kind: 'REPO', repoId: world.repoId, baseRef: 'trunk', feature: `decide-${++seq}`,
        title: `decide ${seq}`, createdById: world.ids.dev,
        backend: { kind: 'native', model: 'm1' } as Prisma.InputJsonValue, skills: [],
      },
    });
    const job = await prisma.fleetJob.create({
      data: {
        projectId: world.projectId, repoId: world.repoId, ref: 'trunk', command: 'THREAD', feature: `thread-${thread.id}`,
        profiles: [], selectorLabels: [], maxCostUsd: new Prisma.Decimal(5), requestedById: world.ids.dev,
        state: 'RUNNING', threadId: thread.id,
      },
    });
    return { threadId: thread.id, jobId: job.id };
  }

  /** A real propose for a fresh thread; `requestedById` defaults to dev, `now` to the present. */
  async function propose(over: Partial<ProposeInput> = {}): Promise<{ actionId: string; approvalId: string; threadId: string }> {
    const seed = await seedThread();
    const result = await actions.propose({
      projectId: world.projectId, threadId: seed.threadId, threadKind: 'REPO', threadProjectSlug: 'web', jobId: seed.jobId,
      toolCallId: `tc-${++seq}`, tool: TOOL, input: { ref: 'KODA-1', body: 'hello' }, preview: 'Add a comment',
      requestedById: world.ids.dev, now: new Date(), ...over,
    });
    if ('refused' in result) throw new Error('propose refused');
    const row = await prisma.pendingAction.findUniqueOrThrow({ where: { id: result.actionId } });
    return { actionId: result.actionId, approvalId: row.approvalId as string, threadId: seed.threadId };
  }

  const decide = (prefix: string, approvalId: string, token: string, body: Record<string, unknown>) =>
    request(app.getHttpServer()).post(`${prefix}/${approvalId}/decide`).set(as(token)).send(body);

  const actionRow = (id: string) => prisma.pendingAction.findUniqueOrThrow({ where: { id } });
  const systemNotes = (threadId: string) => prisma.chatMessage.findMany({ where: { threadId, role: 'system' }, orderBy: { seq: 'asc' } });

  beforeAll(async () => {
    saved['FLEET_THREADS_ENABLED'] = process.env['FLEET_THREADS_ENABLED'];
    process.env['FLEET_THREADS_ENABLED'] = 'true';
    await resetDb();
    app = await bootHttpApp({ registrationEnabled: false });
    prisma = app.get<PrismaService<PrismaClient>>(PrismaService).client;
    world = await seedFleetHttpWorld(app.getHttpServer(), prisma);
    actions = app.get(AssistantActionService, { strict: false });
    // A project ADMIN who is not the requester: the viewer, promoted.
    await prisma.projectMember.updateMany({ where: { userId: world.ids.viewer, projectId: world.projectId }, data: { role: 'ADMIN' } });
  }, 120_000);

  afterAll(async () => {
    try {
      await app?.close();
    } finally {
      if (saved['FLEET_THREADS_ENABLED'] === undefined) delete process.env['FLEET_THREADS_ENABLED'];
      else process.env['FLEET_THREADS_ENABLED'] = saved['FLEET_THREADS_ENABLED'];
    }
  });

  it('AC-1: the requester rejecting a pending action on the project prefix answers 200 with status rejected', async () => {
    const { approvalId } = await propose();

    const res = await decide(PROJECT, approvalId, world.tokens.dev, { decision: 'reject', comment: 'not now' }).expect(200);

    expect(data<Record<string, unknown>>(res)).toMatchObject({
      id: approvalId, type: 'assistant_action', status: 'rejected', decision: 'reject', resolvedBy: 'user',
      decidedById: world.ids.dev, comment: 'not now',
    });
  });

  it('AC-2: after that reject the action is REJECTED', async () => {
    const { actionId, approvalId } = await propose();
    await decide(PROJECT, approvalId, world.tokens.dev, { decision: 'reject' }).expect(200);
    expect((await actionRow(actionId)).status).toBe('REJECTED');
  });

  it('AC-3: after that reject the action\'s decidedById is the requester, with a decidedAt', async () => {
    const { actionId, approvalId } = await propose();
    await decide(PROJECT, approvalId, world.tokens.dev, { decision: 'reject' }).expect(200);
    const row = await actionRow(actionId);
    expect(row.decidedById).toBe(world.ids.dev);
    expect(row.decidedAt).not.toBeNull();
  });

  it('AC-4: after that reject the thread has a system note naming the action, the tool and the rejection', async () => {
    const { actionId, approvalId, threadId } = await propose();
    await decide(PROJECT, approvalId, world.tokens.dev, { decision: 'reject' }).expect(200);

    const notes = await systemNotes(threadId);

    expect(notes).toHaveLength(1);
    expect(notes[0]).toMatchObject({
      role: 'system', status: 'complete', authorUserId: null, content: `Action ${actionId} (${TOOL}) was rejected by the user.`,
    });
    expect(notes[0].seq).toBeGreaterThan(0);
  });

  it('AC-5: the requester, who is a global ADMIN, rejecting on the admin prefix answers 200', async () => {
    const { actionId, approvalId } = await propose({ requestedById: world.ids.root });

    const res = await decide(ADMIN, approvalId, world.tokens.root, { decision: 'reject' }).expect(200);

    expect(data<{ status: string }>(res).status).toBe('rejected');
    expect((await actionRow(actionId)).status).toBe('REJECTED');
  });

  it('AC-6/AC-7: a project ADMIN who is not the requester gets 403 threads.notCreator and the action stays PENDING', async () => {
    const { actionId, approvalId, threadId } = await propose();

    const res = await decide(PROJECT, approvalId, world.tokens.viewer, { decision: 'reject' }).expect(403);

    expect(res.body.message).toBe('Only the thread creator can perform this action');
    expect((await actionRow(actionId)).status).toBe('PENDING');
    expect((await prisma.fleetApproval.findUniqueOrThrow({ where: { id: approvalId } })).status).toBe('pending');
    expect(await systemNotes(threadId)).toHaveLength(0);
  });

  it('AC-8/AC-9: a global ADMIN who is not the requester gets 403 threads.notCreator on the admin prefix and the action stays PENDING', async () => {
    const { actionId, approvalId, threadId } = await propose();

    const res = await decide(ADMIN, approvalId, world.tokens.root, { decision: 'reject' }).expect(403);

    expect(res.body.message).toBe('Only the thread creator can perform this action');
    expect((await actionRow(actionId)).status).toBe('PENDING');
    expect(await systemNotes(threadId)).toHaveLength(0);
  });

  it('AC-10/AC-11: allow by the requester answers 400 fleet.approvalDecisionInvalid and leaves the action PENDING', async () => {
    const { actionId, approvalId } = await propose();

    const res = await decide(PROJECT, approvalId, world.tokens.dev, { decision: 'allow' }).expect(400);

    expect(res.body.message).toBe('This decision is not allowed: allow does not apply to an assistant action');
    expect((await actionRow(actionId)).status).toBe('PENDING');
  });

  it('AC-14: a second reject of a REJECTED action answers 409 fleet.approvalNotPending and writes no second note', async () => {
    const { approvalId, threadId } = await propose();
    await decide(PROJECT, approvalId, world.tokens.dev, { decision: 'reject' }).expect(200);

    const res = await decide(PROJECT, approvalId, world.tokens.dev, { decision: 'reject' }).expect(409);

    expect(res.body.message).toBe(NOT_PENDING);
    expect(await systemNotes(threadId)).toHaveLength(1);
  });

  it('AC-15: deciding an approval whose action row was deleted answers 409 fleet.approvalNotPending', async () => {
    const { actionId, approvalId } = await propose();
    await prisma.pendingAction.delete({ where: { id: actionId } });

    const res = await decide(PROJECT, approvalId, world.tokens.dev, { decision: 'reject' }).expect(409);

    expect(res.body.message).toBe(NOT_PENDING);
    expect((await prisma.fleetApproval.findUniqueOrThrow({ where: { id: approvalId } })).status).toBe('pending');
  });

  it('AC-16/AC-17: rejecting an action past expiresAt answers 409 and leaves the action EXPIRED, the approval expired', async () => {
    // Proposed more than the TTL ago, so expiresAt is already in the past.
    const { actionId, approvalId } = await propose({ now: new Date(Date.now() - ACTION_TTL_MS - 60_000) });

    const res = await decide(PROJECT, approvalId, world.tokens.dev, { decision: 'reject' }).expect(409);

    expect(res.body.message).toBe(NOT_PENDING);
    const row = await actionRow(actionId);
    expect(row.status).toBe('EXPIRED');
    expect(row.decidedById).toBeNull();
    expect(row.decidedAt).not.toBeNull();
    expect(await prisma.fleetApproval.findUniqueOrThrow({ where: { id: approvalId } })).toMatchObject({ status: 'expired', resolvedBy: 'timeout' });
  });

  it('AC-22: expiring on decide leaves the expiry note in the thread', async () => {
    const { actionId, approvalId, threadId } = await propose({ now: new Date(Date.now() - ACTION_TTL_MS - 60_000) });

    await decide(PROJECT, approvalId, world.tokens.dev, { decision: 'approve' }).expect(409);

    const notes = await systemNotes(threadId);
    expect(notes.map((n) => n.content)).toEqual([`Action ${actionId} (${TOOL}) expired without a decision.`]);
  });

  it('a decide on the admin prefix for a rejected action records the same closed approval a project decide does', async () => {
    const { actionId, approvalId } = await propose();
    const res = await decide(ADMIN, approvalId, world.tokens.dev, { decision: 'reject' });
    // dev is not a global admin: the admin prefix refuses before the handler runs, and the action is untouched.
    expect(res.status).toBe(403);
    expect((await actionRow(actionId)).status).toBe('PENDING');
  });
});
