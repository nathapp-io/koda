/**
 * Fleet S5b 2aw US-002 — the outcome hand-off inside `PrismaChatThreadRepository.sendMessage` over PG (2aw-D3): the
 * thread's undelivered terminal actions are selected in age order (at most 20 of them), marked delivered on the new
 * user message in one update, and their notes ride the `THREAD_INPUT` text of a live session's send — or the
 * `initialMessage.text` a new-turn job rebuilds from `deliveredMessageId` (US-001). A note that does not fit the byte
 * budget stays for the next message; a duplicate `clientMessageId` and a refused send deliver nothing.
 *
 * The world is seeded the way `assistant-action-delivery.integration.spec.ts` (US-001) seeds it: rows straight into
 * PG, the repository called in process and `findThreadAssign` for the new-turn seam. Acceptance setup:
 * FLEET_THREADS_ENABLED=true before boot (the S5a kill switch, off in every test run), so a send is judged on the
 * thread's own state instead of answering `threads.disabled`.
 *
 * Run: cd apps/api && bun run test:db:up && bun run test:scoped test/integration/fleet/assistant-action-send-delivery.integration.spec.ts
 */
import { NathApplication } from '@nathapp/nestjs-app';
import { PrismaService } from '@nathapp/nestjs-prisma';
import { Prisma, PrismaClient } from '../../../src/generated/prisma/client';
import { FLEET_CFG, IFleetConfig } from '../../../src/config/fleet.config';
import { PrismaChatThreadRepository } from '../../../src/fleet/threads/prisma-chat-thread.repository';
import { PrismaFleetJobRepository } from '../../../src/fleet/jobs/prisma-fleet-job.repository';
import { DELIVERY_HEADER, deliveryText } from '../../../src/fleet/assistant/actions/outcome-delivery';
import { outcomeNote } from '../../../src/fleet/assistant/actions/outcome-note';
import type { PendingActionStatus } from '../../../src/fleet/assistant/actions/pending-action.domain';
import { THREAD_LIMITS } from '../../../src/fleet/common/thread-jobs';
import { FLEET_CAPS } from '../../helpers/fleet-fixtures';
import { bootHttpApp } from '../../helpers/http-app';
import { resetDb } from '../../helpers/reset-db';

const describeIntegration = process.env.KODA_DB_TESTS === '1' ? describe : describe.skip;
vi.setConfig({ testTimeout: 30_000 });

const TOOL = 'koda_add_comment';

/** A thread with its live RUNNING SESSION's job, or the thread's id alone when it has no session. */
interface SeededThread { threadId: string; jobId: string | null }

describeIntegration('delivering outcome notes in sendMessage (PG, 2aw US-002)', () => {
  let app: NathApplication;
  let prisma: PrismaClient;
  let threads: PrismaChatThreadRepository;
  let jobs: PrismaFleetJobRepository;
  let userId: string;
  let projectId: string;
  let repoId: string;
  let runnerId: string;
  let seq = 0;
  let savedThreadsEnabled: string | undefined;

  const uid = (prefix: string): string => `${prefix}-${++seq}`;
  /** The scope of every send in this file; `projectId` is read lazily, it is seeded in `beforeAll`. */
  const scope = { kind: 'project' as const, get projectId(): string { return projectId; } };

  /** An admin, a project with a GitHub repo, and an online runner the thread sessions are pinned to. */
  async function seedWorld(): Promise<void> {
    userId = (await prisma.user.create({ data: { email: `${uid('handoff')}@koda.test`, passwordHash: 'x' } })).id;
    const slug = uid('handoff');
    projectId = (await prisma.project.create({ data: { name: slug, slug, key: slug.slice(0, 12).toUpperCase() } })).id;
    repoId = (await prisma.fleetRepo.create({
      data: { projectId, provider: 'github', owner: 'acme', name: uid('app'), defaultBranch: 'trunk', githubInstallationId: BigInt(77), createdById: userId },
    })).id;
    runnerId = (await prisma.runner.create({
      data: {
        name: uid('runner'), apiKeyHash: uid('key'), os: 'linux', arch: 'x64', labels: [], capacity: 2,
        capabilities: { ...FLEET_CAPS, threadWrite: true } as object, daemonVersion: '0.1.0',
        protocolVersion: 5, bootId: uid('boot'), enabled: true, lastSeenAt: new Date(), createdById: userId,
      },
    })).id;
  }

  /**
   * A REPO thread, by default with a live RUNNING SESSION: its THREAD job, that job's turn and the pinned runner.
   * Without a session the thread is idle and a send creates a new turn.
   *
   * The row goes through the repository's own `create`, the only path that fills every REPO field the turn factory
   * requires (`specPath` included from the feature), and only `runnerId` is written afterwards, because `create` does
   * not take one. A hand-written row that skips `specPath` is refused `threads.notRepoThread` by `repoThreadFields`
   * the moment a new turn is built.
   */
  async function seedThread(opts: { live?: boolean } = {}): Promise<SeededThread> {
    const live = opts.live ?? true;
    const created = await threads.create({
      kind: 'REPO', projectId, repoId, baseRef: 'trunk', feature: uid('handoff'), title: 'Hand-off',
      createdById: userId, backend: { kind: 'native', model: 'm1' }, skills: [], maxCostUsd: '5',
    });
    if (!live) return { threadId: created.id, jobId: null };
    // The pinned runner is online for the send that is about to run, whatever the file's elapsed time.
    await prisma.chatThread.update({ where: { id: created.id }, data: { runnerId } });
    await prisma.runner.update({ where: { id: runnerId }, data: { lastSeenAt: new Date() } });
    const job = await prisma.fleetJob.create({
      data: {
        projectId, repoId, ref: 'trunk', command: 'THREAD', feature: `thread-${created.id}`, profiles: [], selectorLabels: [],
        maxCostUsd: new Prisma.Decimal(5), requestedById: userId, state: 'RUNNING', runnerId, leaseEpoch: 3, threadId: created.id,
      },
    });
    await prisma.fleetThreadTurn.create({
      data: {
        jobId: job.id, threadId: created.id, action: 'SESSION', initialMessageId: null, instructions: 'go',
        backend: { kind: 'native', model: 'm1' } as Prisma.InputJsonValue, skills: [], resume: false,
      },
    });
    return { threadId: created.id, jobId: job.id };
  }

  /** An undelivered action of `threadId`: what the probe service writes, minus the approval link. */
  async function seedAction(p: {
    threadId: string; status: PendingActionStatus; createdAt: Date; result?: string | null;
  }) {
    return prisma.pendingAction.create({
      data: {
        projectId, threadId: p.threadId, jobId: `job-${p.threadId}`, toolCallId: uid('tc'), tool: TOOL,
        input: { ref: 'KODA-1', body: 'hello' } as Prisma.InputJsonValue, preview: 'Add a comment', status: p.status,
        actorType: 'user', actorId: userId, result: p.result ?? null,
        expiresAt: new Date(Date.now() + 3_600_000), createdAt: p.createdAt,
      },
    });
  }

  const send = (threadId: string, text: string, clientMessageId: string) =>
    threads.sendMessage({ scope, threadId, userId, text, clientMessageId });

  /** The one action of a due pair of assertions: the row as stored. */
  const actionRow = (id: string) => prisma.pendingAction.findUniqueOrThrow({ where: { id } });

  /** The THREAD_INPUT a send queued: a job gets at most one per send, so the message id names it exactly. */
  async function inputPayload(jobId: string | null, messageId: string): Promise<{ messageId: string; text: string }> {
    if (jobId === null) throw new Error('the seeded thread has no live job');
    const commands = await prisma.fleetCommand.findMany({ where: { jobId, type: 'THREAD_INPUT' } });
    const command = commands.find((row) => (row.payload as { messageId?: string }).messageId === messageId);
    if (!command) throw new Error(`no THREAD_INPUT for message ${messageId} of job ${jobId}`);
    return command.payload as unknown as { messageId: string; text: string };
  }

  const noteOf = (row: { id: string; tool: string; status: string; result: string | null }): string =>
    outcomeNote({ id: row.id, tool: row.tool, status: row.status as PendingActionStatus, result: row.result });

  beforeAll(async () => {
    // S5a kill switch: without it every send answers `threads.disabled` before it can hand anything over.
    savedThreadsEnabled = process.env['FLEET_THREADS_ENABLED'];
    process.env['FLEET_THREADS_ENABLED'] = 'true';
    await resetDb();
    app = await bootHttpApp({ registrationEnabled: false });
    prisma = app.get<PrismaService<PrismaClient>>(PrismaService).client;
    threads = app.get(PrismaChatThreadRepository, { strict: false });
    jobs = app.get(PrismaFleetJobRepository, { strict: false });
    // The booted config must have taken the flag, not the env var alone: otherwise every send is refused.
    expect(app.get<IFleetConfig>(FLEET_CFG).threadsEnabled).toBe(true);
    await seedWorld();
  }, 120_000);

  afterAll(async () => {
    try {
      await app?.close();
    } finally {
      if (savedThreadsEnabled === undefined) delete process.env['FLEET_THREADS_ENABLED'];
      else process.env['FLEET_THREADS_ENABLED'] = savedThreadsEnabled;
    }
  });

  it('AC-1: a live send queues a THREAD_INPUT whose text is the note block above the user text', async () => {
    const { threadId, jobId } = await seedThread();
    const action = await seedAction({ threadId, status: 'EXECUTED', createdAt: new Date('2026-01-01T00:00:00.000Z'), result: 'done' });

    const { message } = await send(threadId, 'hello', uid('cm'));

    expect(await inputPayload(jobId, message.id)).toEqual({
      messageId: message.id,
      text: `${DELIVERY_HEADER}\n${noteOf(action)}\n\nhello`,
    });
    expect(noteOf(action)).toContain('was approved and done: done');
  });

  it('AC-2: the delivered action carries a deliveredAt', async () => {
    const { threadId } = await seedThread();
    const action = await seedAction({ threadId, status: 'EXECUTED', createdAt: new Date('2026-01-01T00:00:00.000Z'), result: 'done' });

    await send(threadId, 'hello', uid('cm'));

    expect((await actionRow(action.id)).deliveredAt).not.toBeNull();
  });

  it('AC-3: the delivered action names the new user message', async () => {
    const { threadId } = await seedThread();
    const action = await seedAction({ threadId, status: 'EXECUTED', createdAt: new Date('2026-01-01T00:00:00.000Z'), result: 'done' });

    const { message } = await send(threadId, 'hello', uid('cm'));

    expect((await actionRow(action.id)).deliveredMessageId).toBe(message.id);
  });

  it('AC-4: the stored user message keeps the plain text', async () => {
    const { threadId } = await seedThread();
    await seedAction({ threadId, status: 'EXECUTED', createdAt: new Date('2026-01-01T00:00:00.000Z'), result: 'done' });

    const { message } = await send(threadId, 'hello', uid('cm'));

    expect((await prisma.chatMessage.findUniqueOrThrow({ where: { id: message.id } })).content).toBe('hello');
  });

  it('AC-5: a second send after the first message is finished carries only the new text', async () => {
    const { threadId, jobId } = await seedThread();
    await seedAction({ threadId, status: 'EXECUTED', createdAt: new Date('2026-01-01T00:00:00.000Z'), result: 'done' });
    const first = await send(threadId, 'hello', uid('cm'));
    await prisma.chatMessage.update({ where: { id: first.message.id }, data: { status: 'complete' } });

    const second = await send(threadId, 'again', uid('cm'));

    expect(await inputPayload(jobId, second.message.id)).toEqual({ messageId: second.message.id, text: 'again' });
  });

  it('AC-6: a PENDING action keeps deliveredAt null after a send', async () => {
    const { threadId } = await seedThread();
    const pending = await seedAction({ threadId, status: 'PENDING', createdAt: new Date('2026-01-01T00:00:00.000Z'), result: null });
    const executed = await seedAction({ threadId, status: 'EXECUTED', createdAt: new Date('2026-01-01T00:01:00.000Z'), result: 'done' });

    await send(threadId, 'hello', uid('cm'));

    expect((await actionRow(pending.id)).deliveredAt).toBeNull();
    // The terminal neighbour is delivered, so the assertion above is about the status filter, not a no-op.
    expect((await actionRow(executed.id)).deliveredAt).not.toBeNull();
  });

  it('AC-7: an APPROVED action keeps deliveredAt null after a send', async () => {
    const { threadId } = await seedThread();
    const approved = await seedAction({ threadId, status: 'APPROVED', createdAt: new Date('2026-01-01T00:00:00.000Z'), result: null });
    const executed = await seedAction({ threadId, status: 'EXECUTED', createdAt: new Date('2026-01-01T00:01:00.000Z'), result: 'done' });

    await send(threadId, 'hello', uid('cm'));

    expect((await actionRow(approved.id)).deliveredAt).toBeNull();
    expect((await actionRow(executed.id)).deliveredAt).not.toBeNull();
  });

  it('AC-8: a terminal action of another thread keeps deliveredAt null after a send', async () => {
    const other = await seedThread();
    const elsewhere = await seedAction({ threadId: other.threadId, status: 'EXECUTED', createdAt: new Date('2026-01-01T00:00:00.000Z'), result: 'done' });
    const { threadId } = await seedThread();
    const mine = await seedAction({ threadId, status: 'EXECUTED', createdAt: new Date('2026-01-01T00:00:00.000Z'), result: 'done' });

    await send(threadId, 'hello', uid('cm'));

    expect((await actionRow(elsewhere.id)).deliveredAt).toBeNull();
    // The send's own thread is delivered, so the assertion above is about the thread filter and not about a no-op.
    expect((await actionRow(mine.id)).deliveredAt).not.toBeNull();
  });

  /** 21 undelivered terminal actions with increasing, distinct `createdAt` values on a live thread. */
  async function seedTwentyOne(threadId: string) {
    const rows = [] as Awaited<ReturnType<typeof seedAction>>[];
    for (let i = 0; i < 21; i += 1) {
      rows.push(await seedAction({
        threadId, status: 'EXECUTED', result: 'ok', createdAt: new Date(Date.UTC(2026, 0, 1, 0, i)),
      }));
    }
    return rows;
  }

  it('AC-9: 21 undelivered actions leave exactly 20 with deliveredAt set', async () => {
    const { threadId } = await seedThread();
    await seedTwentyOne(threadId);

    await send(threadId, 'hello', uid('cm'));

    expect(await prisma.pendingAction.count({ where: { threadId, deliveredAt: { not: null } } })).toBe(20);
  });

  it('AC-10: the action with the latest createdAt keeps deliveredAt null', async () => {
    const { threadId } = await seedThread();
    const seeded = await seedTwentyOne(threadId);

    await send(threadId, 'hello', uid('cm'));

    const latest = seeded[20];
    const previous = seeded[19];
    if (!latest || !previous) throw new Error('the seed left fewer than 21 actions');
    expect(latest.createdAt.getTime()).toBeGreaterThan(previous.createdAt.getTime());
    expect((await actionRow(latest.id)).deliveredAt).toBeNull();
  });

  it('AC-11: a note that does not fit the byte budget stays undelivered', async () => {
    const { threadId, jobId } = await seedThread();
    const first = await seedAction({ threadId, status: 'EXECUTED', result: 'ok', createdAt: new Date('2026-01-01T00:00:00.000Z') });
    const second = await seedAction({ threadId, status: 'FAILED', result: 'ok', createdAt: new Date('2026-01-01T00:01:00.000Z') });
    const notes = [noteOf(first), noteOf(second)];
    const oneNote = `${DELIVERY_HEADER}\n${notes[0]}\n\n`;
    // The user text is sized with the delivery helper: the whole text fills the budget with the first note only.
    const text = 'x'.repeat(THREAD_LIMITS.messageMaxBytes - Buffer.byteLength(oneNote, 'utf8'));

    expect(deliveryText(notes, text, THREAD_LIMITS.messageMaxBytes)).toEqual({ text: oneNote + text, delivered: 1 });
    const { message } = await send(threadId, text, uid('cm'));

    expect((await actionRow(first.id)).deliveredAt).not.toBeNull();
    expect((await actionRow(second.id)).deliveredAt).toBeNull();
    expect((await actionRow(second.id)).deliveredMessageId).toBeNull();
    expect((await inputPayload(jobId, message.id)).text).toBe(oneNote + text);
  });

  it('AC-12: a repeated clientMessageId delivers nothing, an action created between the sends included', async () => {
    const { threadId } = await seedThread();
    const delivered = await seedAction({ threadId, status: 'EXECUTED', result: 'done', createdAt: new Date('2026-01-01T00:00:00.000Z') });
    const clientMessageId = uid('cm');
    const first = await send(threadId, 'hello', clientMessageId);
    const later = await seedAction({ threadId, status: 'EXECUTED', result: 'done', createdAt: new Date('2026-01-02T00:00:00.000Z') });

    const repeated = await send(threadId, 'hello', clientMessageId);

    expect(repeated.deduplicated).toBe(true);
    expect(repeated.message.id).toBe(first.message.id);
    expect((await actionRow(delivered.id)).deliveredMessageId).toBe(first.message.id);
    expect((await actionRow(later.id)).deliveredAt).toBeNull();
  });

  it('AC-13: a new turn carries the delivered note above the user text', async () => {
    const { threadId } = await seedThread({ live: false });
    const action = await seedAction({ threadId, status: 'REJECTED', result: null, createdAt: new Date('2026-01-01T00:00:00.000Z') });

    const { message, jobId } = await send(threadId, 'hi', uid('cm'));

    if (jobId === null) throw new Error('the new-turn send created no job');
    const assign = await jobs.findThreadAssign(jobId);
    expect(assign?.initialMessage).toEqual({
      messageId: message.id,
      text: `${DELIVERY_HEADER}\n${noteOf(action)}\n\nhi`,
    });
    expect(noteOf(action)).toContain('was rejected by the user');
  });

  it('AC-14: the new turn\'s delivered action names the new user message', async () => {
    const { threadId } = await seedThread({ live: false });
    const action = await seedAction({ threadId, status: 'REJECTED', result: null, createdAt: new Date('2026-01-01T00:00:00.000Z') });

    const { message } = await send(threadId, 'hi', uid('cm'));

    expect((await actionRow(action.id)).deliveredMessageId).toBe(message.id);
  });

  /** A live thread whose prior turn is still pending: `sendRefusal` answers `turnRunning` for the next send. */
  async function seedRefusingSend() {
    const { threadId, jobId } = await seedThread();
    const action = await seedAction({ threadId, status: 'EXECUTED', result: 'done', createdAt: new Date('2026-01-01T00:00:00.000Z') });
    await prisma.chatMessage.create({
      data: { threadId, seq: 50, jobId: null, role: 'user', status: 'pending', content: 'still running', authorUserId: userId },
    });
    return { threadId, jobId, action };
  }

  it('AC-15: a refused send leaves a terminal action\'s deliveredAt null', async () => {
    const { threadId, jobId, action } = await seedRefusingSend();

    await expect(send(threadId, 'hello', uid('cm'))).rejects.toMatchObject({ prefix: 'threads.turnRunning' });

    expect((await actionRow(action.id)).deliveredAt).toBeNull();
    // The refused send wrote nothing at all: no new message and no THREAD_INPUT command of this job.
    if (jobId === null) throw new Error('the seeded thread has no live job');
    expect(await prisma.chatMessage.count({ where: { threadId } })).toBe(1);
    expect(await prisma.fleetCommand.count({ where: { jobId } })).toBe(0);
  });

  it('AC-16: a refused send leaves a terminal action\'s deliveredMessageId null', async () => {
    const { threadId, action } = await seedRefusingSend();

    await expect(send(threadId, 'hello', uid('cm'))).rejects.toMatchObject({ prefix: 'threads.turnRunning' });

    expect((await actionRow(action.id)).deliveredMessageId).toBeNull();
  });
});
