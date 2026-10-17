/**
 * Fleet S5b 2a US-004 — thread detail pending actions (2a-D12) and the creator-only ask (2a-D6), against PG.
 *
 * The actions are seeded through a real `AssistantActionService.propose` (spec §Stories: "DB-backed tests seed a
 * PendingAction through AssistantActionService.propose"), and the notification seam runs
 * `FleetApprovalRequestedSubscriber.handle` on the outbox payload that propose itself enqueued — never on a
 * hand-authored approximation of it.
 *
 * Run: cd apps/api && bun run test:db:up && bun run test:scoped test/integration/fleet/assistant-action-detail.integration.spec.ts
 */
import { NathApplication } from '@nathapp/nestjs-app';
import { PrismaService } from '@nathapp/nestjs-prisma';
import request from 'supertest';
import { Prisma, PrismaClient } from '../../../src/generated/prisma/client';
import { AssistantActionService } from '../../../src/fleet/assistant/actions/assistant-action.service';
import type { ProposeInput } from '../../../src/fleet/assistant/actions/pending-action.domain';
import { FleetApprovalRequestedSubscriber } from '../../../src/notifications/fleet/fleet-approval-requested.subscriber';
import { resetDb } from '../../helpers/reset-db';
import { bootHttpApp, data } from '../../helpers/http-app';
import { seedFleetHttpWorld, type FleetHttpWorld } from '../../helpers/fleet-fixtures';

const describeIntegration = process.env.KODA_DB_TESTS === '1' ? describe : describe.skip;
vi.setConfig({ testTimeout: 30_000 });

const NOW = new Date('2026-10-23T09:00:00.000Z');
const TOOL = 'koda_add_comment';
const PREVIEW = 'Add a comment to KODA-1 "Fix login":\n\nhello';

interface PendingEntry {
  id: string; approvalId: string | null; tool: string; preview: string; projectSlug: string; expiresAt: string; createdAt: string;
}

interface Detail { pendingActions: PendingEntry[] }

interface Seed { threadId: string; jobId: string }

describeIntegration('thread detail pending actions and the creator-only ask (PG, US-004)', () => {
  let app: NathApplication;
  let prisma: PrismaClient;
  let world: FleetHttpWorld;
  let actions: AssistantActionService;
  let subscriber: FleetApprovalRequestedSubscriber;
  let seq = 0;

  /** A thread of `kind` in `projectId`, with a RUNNING THREAD job on it: what propose requires to store an action. */
  async function seedThread(kind: 'REPO' | 'WORKSPACE', projectId = world.projectId): Promise<Seed> {
    const thread = await prisma.chatThread.create({
      data: {
        projectId, kind, repoId: kind === 'REPO' ? world.repoId : null, baseRef: kind === 'REPO' ? 'trunk' : null,
        feature: kind === 'REPO' ? `detail-${++seq}` : null, title: `detail ${seq}`, createdById: world.ids.dev,
        backend: { kind: 'native', model: 'm1' } as Prisma.InputJsonValue, skills: [],
      },
    });
    const job = await prisma.fleetJob.create({
      data: {
        projectId, repoId: world.repoId, ref: 'trunk', command: 'THREAD', feature: `thread-${thread.id}`,
        profiles: [], selectorLabels: [], maxCostUsd: new Prisma.Decimal(5), requestedById: world.ids.dev,
        state: 'RUNNING', threadId: thread.id,
      },
    });
    return { threadId: thread.id, jobId: job.id };
  }

  /** One real propose call for `seed`; every field is the default unless a test overrides it. */
  async function propose(seed: Seed, over: Partial<ProposeInput> = {}): Promise<string> {
    const result = await actions.propose({
      projectId: world.projectId, threadId: seed.threadId, threadKind: 'REPO', threadProjectSlug: 'web',
      jobId: seed.jobId, toolCallId: `tc-${++seq}`, tool: TOOL, input: { ref: 'KODA-1', body: 'hello' },
      preview: PREVIEW, requestedById: world.ids.dev, now: NOW, ...over,
    });
    if ('refused' in result) throw new Error('propose refused');
    return result.actionId;
  }

  const actionRow = (id: string) => prisma.pendingAction.findUniqueOrThrow({ where: { id } });

  /** The detail route as the dev user reads it, unwrapped. */
  async function getDetail(path: string, token = world.tokens.dev): Promise<Detail> {
    return data<Detail>(await request(app.getHttpServer()).get(path).set({ Authorization: `Bearer ${token}` }).expect(200));
  }

  const notifications = () => prisma.notification.findMany({ orderBy: { createdAt: 'asc' } });

  beforeAll(async () => {
    await resetDb();
    app = await bootHttpApp({ registrationEnabled: false });
    prisma = app.get<PrismaService<PrismaClient>>(PrismaService).client;
    world = await seedFleetHttpWorld(app.getHttpServer(), prisma);
    actions = app.get(AssistantActionService, { strict: false });
    subscriber = app.get(FleetApprovalRequestedSubscriber, { strict: false });
  }, 120_000);

  afterAll(async () => {
    await app?.close();
  });

  beforeEach(async () => {
    // The ask tests assert on the rows one handle creates, so each starts from an empty inbox.
    await prisma.notification.deleteMany();
  });

  it('AC-1: a thread with one PENDING and one REJECTED action answers exactly one entry', async () => {
    const seed = await seedThread('REPO');
    const pending = await propose(seed);
    const decided = await propose(seed);
    await prisma.pendingAction.update({ where: { id: decided }, data: { status: 'REJECTED', decidedAt: NOW, decidedById: world.ids.dev } });

    const detail = await getDetail(`/api/projects/web/threads/${seed.threadId}`);

    expect(detail.pendingActions).toHaveLength(1);
    expect(detail.pendingActions[0]?.id).toBe(pending);
  });

  it('AC-2: the entry equals the pending action id, approvalId, tool and preview', async () => {
    const seed = await seedThread('REPO');
    const id = await propose(seed);
    const stored = await actionRow(id);

    const [entry] = (await getDetail(`/api/projects/web/threads/${seed.threadId}`)).pendingActions;

    expect(entry).toMatchObject({ id, approvalId: stored.approvalId, tool: TOOL, preview: PREVIEW });
    expect(entry?.preview).toBe(stored.preview);
    expect(entry?.approvalId).not.toBeNull();
  });

  it('AC-3: the entry projectSlug is the project the thread belongs to', async () => {
    const seed = await seedThread('REPO');
    await propose(seed);

    const [entry] = (await getDetail(`/api/projects/web/threads/${seed.threadId}`)).pendingActions;

    expect(entry?.projectSlug).toBe('web');
    expect(world.projectId).toBe((await actionRow(entry?.id as string)).projectId);
  });

  it('AC-4: a WORKSPACE thread whose action acts in project b answers b as the entry slug', async () => {
    const seed = await seedThread('WORKSPACE');
    await propose(seed, { projectId: world.opsProjectId, threadKind: 'WORKSPACE', threadProjectSlug: 'web' });

    const [entry] = (await getDetail(`/api/threads/${seed.threadId}`)).pendingActions;

    expect(entry?.projectSlug).toBe('ops');
  });

  it('AC-5: a thread with no actions answers pendingActions as an empty array', async () => {
    const seed = await seedThread('REPO');

    expect((await getDetail(`/api/projects/web/threads/${seed.threadId}`)).pendingActions).toEqual([]);
  });

  it('AC-6/AC-7/AC-8/AC-9: the ask a real propose enqueued notifies the requester alone, linked to the thread', async () => {
    const seed = await seedThread('REPO');
    const id = await propose(seed);
    const { approvalId } = await actionRow(id);
    const [event] = await prisma.outboxEvent.findMany({ where: { type: 'fleet_approval_requested', eventId: approvalId as string } });
    expect(event).toBeDefined();
    const payload = JSON.parse(event.payload) as { requestedById: string; threadPath: string; tool: string; type: string };
    expect(payload).toMatchObject({ type: 'assistant_action', requestedById: world.ids.dev, threadPath: `/web/threads/${seed.threadId}`, tool: TOOL });

    await subscriber.handle(payload);

    const rows = await notifications();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      userId: world.ids.dev, kind: 'action_requested', category: 'FLEET_NEEDS_YOU',
      link: payload.threadPath, sourceType: 'fleet_approval', sourceId: approvalId,
    });
    expect(rows[0]?.params).toEqual({ tool: TOOL });
    // The requester is the only recipient: no other user, the admins included, is notified.
    expect(rows.filter((row) => row.userId !== world.ids.dev)).toEqual([]);
  });

  it('the same ask handled twice stores one notification, not two', async () => {
    const seed = await seedThread('REPO');
    const id = await propose(seed);
    const { approvalId } = await actionRow(id);
    const [event] = await prisma.outboxEvent.findMany({ where: { type: 'fleet_approval_requested', eventId: approvalId as string } });
    const payload = JSON.parse(event.payload) as unknown;

    await subscriber.handle(payload);
    await subscriber.handle(payload);

    expect(await notifications()).toHaveLength(1);
  });
});
