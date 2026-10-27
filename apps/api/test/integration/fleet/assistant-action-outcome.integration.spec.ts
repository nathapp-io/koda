import { randomUUID } from 'node:crypto';
import type { NathApplication } from '@nathapp/nestjs-app';
import { canRunDbTests } from '../../helpers/test-environment';
import { bootHttpApp } from '../../helpers/http-app';
import { resetDb } from '../../helpers/reset-db';
import { fixtureDb, withTestActor } from '../../helpers/action-context';
import type { PrismaClient } from '../../../src/generated/prisma/client';
import { FanOutPublisher } from '../../../src/outbox/fan-out-publisher';
import { APPROVAL_REQUEST_CHANGED } from '../../../src/approvals/approval-request-events';
import { ThreadEventBus, type ThreadLiveEvent } from '../../../src/live/thread-event-bus';

const describeDb = canRunDbTests() ? describe : describe.skip;
const write = <T>(fn: () => Promise<T>) => withTestActor({ type: 'USER', id: 'outcome-test' }, fn);

describeDb('assistant request outcome fan-out (PG)', () => {
  let app: NathApplication;
  let db: PrismaClient;
  let projectId: string;
  let publisher: FanOutPublisher;
  beforeAll(async () => {
    await resetDb();
    app = await bootHttpApp({ registrationEnabled: false });
    db = fixtureDb(app);
    const project = await write(() => db.project.create({ data: { name: 'Outcomes', slug: `outcomes-${randomUUID()}`, key: randomUUID() } }));
    projectId = project.id;
    publisher = app.get(FanOutPublisher, { strict: false });
  }, 120_000);
  afterAll(async () => { await app?.close(); });

  async function fixture(status = 'executed', linked = true, hasThread = true) {
    return write(async () => {
      const thread = await db.chatThread.create({ data: { projectId, kind: 'REPO', title: 'outcome', createdById: 'outcome-test', backend: { kind: 'native', model: 'test' }, skills: [] } });
      const request = await db.approvalRequest.create({ data: {
        permissionKey: 'ticket.comment', projectId, actorType: 'AGENT', actorId: 'outcome-test', origin: 'thread', correlationId: randomUUID(),
        input: {}, inputHash: randomUUID(), requiredMode: 'human', onTimeout: 'reject', approverMustHoldAction: true,
        requireDistinctApprover: false, status, expiresAt: new Date(Date.now() + 60_000), result: { text: 'comment c1 added' },
      } });
      if (linked) await db.assistantActionRequest.create({ data: { requestId: request.id, threadId: hasThread ? thread.id : null, tool: 'koda_add_comment', preview: 'p' } });
      const record = { id: randomUUID(), type: APPROVAL_REQUEST_CHANGED, payload: {
        requestId: request.id, status, permissionKey: 'ticket.comment', actorId: 'outcome-test', actorType: 'AGENT', projectId,
        requiredMode: 'human', onBehalfOfType: null, onBehalfOfId: null, expiresAt: request.expiresAt.toISOString(),
      } } as Parameters<FanOutPublisher['publish']>[0];
      return { thread, request, record };
    });
  }
  it('AC-1,2,3,7: writes one system note, marks the link and emits committed frames in order; redelivery is idempotent', async () => {
    const { thread, request, record } = await fixture();
    const frames: ThreadLiveEvent[] = [];
    const committed: Promise<number>[] = [];
    const unsubscribe = app.get(ThreadEventBus, { strict: false }).subscribe(thread.id, (frame) => {
      frames.push(frame);
      committed.push(db.chatMessage.count({ where: { threadId: thread.id } }));
    });
    try {
      await publisher.publish(record);
      const notes = await db.chatMessage.findMany({ where: { threadId: thread.id }, take: 10 });
      expect(notes).toHaveLength(1);
      expect(notes[0]).toMatchObject({ role: 'system', content: `Action ${request.id} (koda_add_comment) was approved and done: comment c1 added` });
      expect(await db.assistantActionRequest.findUniqueOrThrow({ where: { requestId: request.id } }))
        .toMatchObject({ noteMessageId: notes[0].id, notedAt: expect.any(Date) });
      expect(frames).toEqual([
        expect.objectContaining({ type: 'message', threadId: thread.id, messageId: notes[0].id }),
        expect.objectContaining({ type: 'thread', threadId: thread.id }),
      ]);
      expect(await Promise.all(committed)).toEqual([1, 1]);
      await publisher.publish(record);
      expect(await db.chatMessage.count({ where: { threadId: thread.id } })).toBe(1);
      expect(frames).toHaveLength(2);
    } finally { unsubscribe(); }
  });
  it.each([
    ['AC-4: unlinked', 'executed', false, true],
    ['AC-5: no thread', 'executed', true, false],
    ['AC-6: pending', 'pending', true, true],
    ['AC-6: approved', 'approved', true, true],
  ] as const)('%s inserts no note', async (_label, status, linked, hasThread) => {
    const { thread, record } = await fixture(status, linked, hasThread);
    await publisher.publish(record);
    expect(await db.chatMessage.count({ where: { threadId: thread.id } })).toBe(0);
  });
  it('AC-8: a deleted thread is a successful no-op', async () => {
    const { thread, record } = await fixture();
    await write(() => db.chatThread.delete({ where: { id: thread.id } }));
    await expect(publisher.publish(record)).resolves.toBeUndefined();
    expect(await db.chatMessage.count({ where: { threadId: thread.id } })).toBe(0);
  });
  it('concurrent redelivery writes exactly one note', async () => {
    const { thread, record } = await fixture();
    await Promise.all([publisher.publish(record), publisher.publish(record)]);
    expect(await db.chatMessage.count({ where: { threadId: thread.id } })).toBe(1);
  });
});
