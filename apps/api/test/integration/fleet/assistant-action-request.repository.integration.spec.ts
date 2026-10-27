import { randomUUID } from 'node:crypto';
import { TRANSACTION_MANAGER, type ITransactionManager } from '@nathapp/nestjs-data';
import { canRunDbTests } from '../../helpers/test-environment';
import { bootHttpApp } from '../../helpers/http-app';
import { resetDb } from '../../helpers/reset-db';
import { fixtureDb, withTestActor } from '../../helpers/action-context';
import type { NathApplication } from '@nathapp/nestjs-app';
import type { PrismaClient } from '../../../src/generated/prisma/client';
import { PrismaAssistantActionRequestRepository } from '../../../src/fleet/assistant/requests/prisma-assistant-action-request.repository';

const describeDb = canRunDbTests() ? describe : describe.skip;
const write = <T>(fn: () => Promise<T>) => withTestActor({ type: 'USER', id: 'assistant-link-test' }, fn);

describeDb('PrismaAssistantActionRequestRepository (PG)', () => {
  let app: NathApplication;
  let db: PrismaClient;
  let repo: PrismaAssistantActionRequestRepository;
  let projectId: string;
  beforeAll(async () => {
    await resetDb();
    app = await bootHttpApp({ registrationEnabled: false });
    db = fixtureDb(app);
    await write(async () => {
      const project = await db.project.create({ data: { name: 'Assistant links', slug: `links-${randomUUID()}`, key: randomUUID() } });
      projectId = project.id;
    });
    repo = app.get(PrismaAssistantActionRequestRepository, { strict: false });
  }, 120_000);
  afterAll(async () => { await app?.close(); });

  async function request(status = 'pending', actorId = 'a1') {
    return write(() => db.approvalRequest.create({ data: {
      permissionKey: 'ticket.comment', projectId, actorType: 'AGENT', actorId, origin: 'thread', correlationId: randomUUID(),
      input: {}, inputHash: randomUUID(), requiredMode: 'human', onTimeout: 'reject', approverMustHoldAction: true,
      requireDistinctApprover: false, status, expiresAt: new Date(Date.now() + 60_000),
    } }));
  }
  async function thread() {
    return db.chatThread.create({ data: {
      projectId, kind: 'REPO', title: 'assistant link', createdById: 'assistant-link-test',
      backend: { kind: 'native', model: 'test' }, skills: [],
    } });
  }
  it('stores and retrieves a request link with empty note and delivery marks', async () => {
    const approval = await request();
    const t = await thread();
    const input = { requestId: approval.id, threadId: t.id, jobId: 'job', toolCallId: 'call', tool: 'koda_add_comment', preview: 'p' };
    expect(await write(() => repo.insert(input))).toMatchObject(input);
    expect(await repo.findByRequest(approval.id)).toMatchObject({ ...input, notedAt: null, deliveredAt: null, deliveredMessageId: null });
  });
  it('counts linked pending requests only and scopes request ownership and thread', async () => {
    const t = await thread();
    const other = await thread();
    const first = await request();
    const second = await request();
    const rejected = await request('rejected');
    const foreign = await request();
    for (const [r, target] of [[first, t], [second, t], [rejected, t], [foreign, other]] as const) {
      await write(() => repo.insert({ requestId: r.id, threadId: target.id, jobId: null, toolCallId: null, tool: 'write', preview: 'p' }));
    }
    expect(await repo.countPendingInThread(t.id)).toBe(2);
    expect(await repo.findScopedInThread(first.id, projectId, t.id)).toMatchObject({ request: { status: 'pending' } });
    expect(await repo.findScopedInThread(foreign.id, projectId, t.id)).toBeNull();
    expect(await repo.findOwnRequest(first.id, projectId, { type: 'AGENT', id: 'a1' })).toMatchObject({ assistantAction: { requestId: first.id } });
    expect(await repo.findOwnRequest(first.id, projectId, { type: 'AGENT', id: 'a2' })).toBeNull();
  });
  it('writes notes in sequence and stores the noted mark; locks existing and missing rows', async () => {
    const t = await thread();
    const approval = await request();
    await write(() => repo.insert({ requestId: approval.id, threadId: t.id, jobId: null, toolCallId: null, tool: 'write', preview: 'p' }));
    const tx = app.get<ITransactionManager>(TRANSACTION_MANAGER);
    await write(() => tx.run(async () => {
      expect(await repo.lockThread(t.id)).toBe(true);
      expect(await repo.lockByRequest(approval.id)).toMatchObject({ requestId: approval.id });
    }));
    const id = await write(() => repo.insertSystemNote(t.id, 'note'));
    const note = await db.chatMessage.findUniqueOrThrow({ where: { id } });
    expect(note).toMatchObject({ content: 'note', role: 'system', seq: 1 });
    const at = new Date();
    await write(() => repo.markNoted(approval.id, id, at));
    expect(await repo.findByRequest(approval.id)).toMatchObject({ noteMessageId: id, notedAt: at });
    expect(await repo.lockThread(t.id)).toBe(true);
    expect(await repo.lockThread('missing')).toBe(false);
    expect(await repo.lockByRequest(approval.id)).toMatchObject({ requestId: approval.id });
    expect(await repo.lockByRequest('missing')).toBeNull();
  });
});
