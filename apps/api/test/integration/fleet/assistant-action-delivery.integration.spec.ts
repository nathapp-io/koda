/**
 * Fleet S5b 2aw US-001 — the delivery column and the new-turn assign over PG: `deliveredMessageId` round-trips
 * through `PrismaPendingActionRepository`, and `findThreadAssign` rebuilds the delivery text from the actions
 * delivered on the initial message (2aw-D1, 2aw-D4).
 *
 * The rows are seeded the way `sendMessage` (US-002) will leave them: an action whose `deliveredAt` and
 * `deliveredMessageId` name the message it was handed on. `findThreadAssign` writes nothing, so the same job answers
 * the same text on every assign, including after a requeue.
 *
 * Run: cd apps/api && bun run test:db:up && bun run test:scoped test/integration/fleet/assistant-action-delivery.integration.spec.ts
 */
import { NathApplication } from '@nathapp/nestjs-app';
import { Prisma, PrismaClient } from '../../../src/generated/prisma/client';
import { PrismaFleetJobRepository } from '../../../src/fleet/jobs/prisma-fleet-job.repository';
import { PrismaPendingActionRepository } from '../../../src/fleet/assistant/actions/prisma-pending-action.repository';
import { DELIVERY_HEADER } from '../../../src/fleet/assistant/actions/outcome-delivery';
import { outcomeNote } from '../../../src/fleet/assistant/actions/outcome-note';
import type { PendingActionStatus } from '../../../src/fleet/assistant/actions/pending-action.domain';
import { bootHttpApp } from '../../helpers/http-app';
import { resetDb } from '../../helpers/reset-db';
import { expectGuardActive, fixtureDb, withTestActor } from '../../helpers/action-context';

const describeIntegration = process.env.KODA_DB_TESTS === '1' ? describe : describe.skip;
vi.setConfig({ testTimeout: 30_000 });

const TOOL = 'koda_add_comment';

interface Turn { projectId: string; threadId: string; jobId: string; messageId: string }

describeIntegration('delivering outcome notes on a new-turn assign (PG, 2aw US-001)', () => {
  let app: NathApplication;
  let prisma: PrismaClient;
  let jobs: PrismaFleetJobRepository;
  let pendingActions: PrismaPendingActionRepository;
  let userId: string;
  let projectId: string;
  let repoId: string;
  let seq = 0;

  const uid = (prefix: string): string => `${prefix}-${++seq}`;

  /** A user, a project and a GitHub repo: what a thread needs to exist. */
  async function seedWorld(): Promise<void> {
    userId = (await prisma.user.create({ data: { email: `${uid('delivery')}@koda.test`, passwordHash: 'x' } })).id;
    const slug = uid('delivery');
    projectId = (await prisma.project.create({ data: { name: slug, slug, key: slug.slice(0, 12).toUpperCase() } })).id;
    repoId = (await prisma.fleetRepo.create({
      data: { projectId, provider: 'github', owner: 'acme', name: uid('app'), defaultBranch: 'trunk', githubInstallationId: BigInt(77), createdById: userId },
    })).id;
  }

  /** A SESSION turn whose initial message is `content`; the thread also owns a second, unrelated message. */
  async function seedTurn(content: string): Promise<Turn> {
    const thread = await prisma.chatThread.create({
      data: {
        projectId, repoId, kind: 'REPO', baseRef: 'trunk', feature: uid('delivery'), title: 'Delivery',
        createdById: userId, backend: { kind: 'native', model: 'm1' } as Prisma.InputJsonValue, skills: [],
      },
    });
    const message = await prisma.chatMessage.create({
      data: { threadId: thread.id, seq: 1, role: 'user', status: 'complete', content, authorUserId: userId },
    });
    const job = await prisma.fleetJob.create({
      data: {
        projectId, repoId, ref: 'trunk', command: 'THREAD', feature: `thread-${thread.id}`, profiles: [], selectorLabels: [],
        maxCostUsd: new Prisma.Decimal(5), requestedById: userId, state: 'QUEUED', threadId: thread.id,
      },
    });
    await prisma.fleetThreadTurn.create({
      data: {
        jobId: job.id, threadId: thread.id, action: 'SESSION', initialMessageId: message.id, instructions: 'go',
        backend: { kind: 'native', model: 'm1' } as Prisma.InputJsonValue, skills: [], resume: false,
      },
    });
    return { projectId, threadId: thread.id, jobId: job.id, messageId: message.id };
  }

  /** Another user message of the same thread, a delivery target that is not this turn's initial message. */
  async function otherMessage(threadId: string): Promise<string> {
    return (await prisma.chatMessage.create({
      data: { threadId, seq: 2, role: 'user', status: 'complete', content: 'another turn', authorUserId: userId },
    })).id;
  }

  /** An action stored the way `sendMessage` leaves a delivered one: `deliveredMessageId` names its message. */
  async function seedAction(p: {
    turn: Turn; deliveredMessageId: string | null; status: PendingActionStatus; createdAt: Date; result?: string;
  }) {
    return prisma.pendingAction.create({
      data: {
        projectId: p.turn.projectId, threadId: p.turn.threadId, jobId: p.turn.jobId, toolCallId: uid('tc'), tool: TOOL,
        input: { ref: 'KODA-1', body: 'hello' } as Prisma.InputJsonValue, preview: 'Add a comment', status: p.status,
        actorType: 'user', actorId: userId, result: p.result ?? null,
        deliveredAt: p.deliveredMessageId === null ? null : new Date(),
        deliveredMessageId: p.deliveredMessageId,
        expiresAt: new Date(Date.now() + 3_600_000), createdAt: p.createdAt,
      },
    });
  }

  const noteOf = (row: { id: string; tool: string; status: string; result: string | null }): string =>
    outcomeNote({ id: row.id, tool: row.tool, status: row.status as PendingActionStatus, result: row.result });

  beforeAll(async () => {
    await resetDb();
    app = await bootHttpApp({ registrationEnabled: false });
    prisma = fixtureDb(app);
    jobs = app.get(PrismaFleetJobRepository, { strict: false });
    pendingActions = app.get(PrismaPendingActionRepository, { strict: false });
    await seedWorld();
  }, 120_000);

  afterAll(async () => {
    await app?.close();
  });

  it('writes need an action context', async () => {
    await expect(expectGuardActive(app)).resolves.toBeUndefined();
  });

  it('AC-7: the assign text is the notes delivered on the initial message, in createdAt order, above the content', async () => {
    const turn = await seedTurn('go');
    const t1 = new Date('2026-01-01T00:00:00.000Z');
    const t2 = new Date('2026-01-01T00:01:00.000Z');
    // Inserted newest first: the text must follow createdAt, not insertion order.
    const second = await seedAction({ turn, deliveredMessageId: turn.messageId, status: 'EXECUTED', result: 'done', createdAt: t2 });
    const first = await seedAction({ turn, deliveredMessageId: turn.messageId, status: 'REJECTED', createdAt: t1 });

    const assign = await jobs.findThreadAssign(turn.jobId);

    expect(assign?.initialMessage).toEqual({
      messageId: turn.messageId,
      text: `${DELIVERY_HEADER}\n${noteOf(first)}\n${noteOf(second)}\n\ngo`,
    });
    expect(noteOf(first)).toContain('was rejected by the user');
    expect(noteOf(second)).toContain('was approved and done: done');
  });

  it('AC-8: an action delivered on another message leaves this turn\'s text equal to the content', async () => {
    const turn = await seedTurn('do the thing');
    await seedAction({ turn, deliveredMessageId: await otherMessage(turn.threadId), status: 'REJECTED', createdAt: new Date() });

    const assign = await jobs.findThreadAssign(turn.jobId);

    expect(assign?.initialMessage).toEqual({ messageId: turn.messageId, text: 'do the thing' });
  });

  it('AC-9: two assigns of the same job answer the same text', async () => {
    const turn = await seedTurn('go');
    const action = await seedAction({ turn, deliveredMessageId: turn.messageId, status: 'FAILED', result: 'it broke', createdAt: new Date() });

    const first = await jobs.findThreadAssign(turn.jobId);
    const second = await jobs.findThreadAssign(turn.jobId);

    expect(first?.initialMessage?.text).toBe(`${DELIVERY_HEADER}\n${noteOf(action)}\n\ngo`);
    expect(second?.initialMessage?.text).toBe(first?.initialMessage?.text);
  });

  it('AC-11: findById answers the deliveredMessageId stored on the row, and writes it back', async () => {
    const turn = await seedTurn('go');
    const action = await seedAction({ turn, deliveredMessageId: null, status: 'REJECTED', createdAt: new Date() });
    const target = await otherMessage(turn.threadId);

    // `sendMessage` writes this back inside the sender's request, so the call runs as that user.
    const updated = await withTestActor({ type: 'USER', id: userId }, () =>
      pendingActions.update(action.id, { deliveredMessageId: target, deliveredAt: new Date() }));
    const read = await pendingActions.findById(action.id);

    expect(updated.deliveredMessageId).toBe(target);
    expect(read?.deliveredMessageId).toBe(target);
    expect((await prisma.pendingAction.findUniqueOrThrow({ where: { id: action.id } })).deliveredMessageId).toBe(target);
  });

  it('AC-12: after a requeue the assign rebuilds the same text from deliveredMessageId', async () => {
    const turn = await seedTurn('go');
    const action = await seedAction({ turn, deliveredMessageId: turn.messageId, status: 'EXPIRED', createdAt: new Date() });
    const before = (await jobs.findThreadAssign(turn.jobId))?.initialMessage?.text;

    // A requeue: the job goes back to the queue with a new lease epoch and no runner, the turn is untouched.
    await prisma.fleetJob.update({ where: { id: turn.jobId }, data: { state: 'QUEUED', leaseEpoch: { increment: 1 }, runnerId: null } });

    const after = await jobs.findThreadAssign(turn.jobId);

    expect(before).toBe(`${DELIVERY_HEADER}\n${noteOf(action)}\n\ngo`);
    expect(after?.initialMessage).toEqual({ messageId: turn.messageId, text: before });
  });
});
