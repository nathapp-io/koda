import { randomUUID } from 'node:crypto';
import { createMockPrismaService, type PrismaService } from '@nathapp/nestjs-prisma';
import { applyMigration, scratchSchemaBefore, type ScratchSchema } from '../../helpers/migration-schema';
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

describeDb('AssistantActionRequest committed migration (PG)', () => {
  let scratch: ScratchSchema;
  beforeAll(async () => {
    scratch = await scratchSchemaBefore(process.env.DATABASE_URL as string, `assistant_link_${randomUUID().replaceAll('-', '')}`, '20261105090000_assistant_action_request');
    await applyMigration(scratch.db, '20261105090000_assistant_action_request');
    // The generated client selects every scalar the model declares, so this chain needs the columns
    // later migrations add to ApprovalRequest too.
    await applyMigration(scratch.db, '20261108090000_approval_request_variant');
    await applyMigration(scratch.db, '20261109090000_approval_request_redeem');
  }, 120_000);
  afterAll(async () => { await scratch?.drop(); });

  it('AC-1: repository insert/read and cascade work after SQL migrations, not db push', async () => {
    const db = scratch.db;
    const prisma = createMockPrismaService({ fn: vi.fn });
    prisma.client = db;
    const tx = { run: vi.fn((fn: () => Promise<unknown>) => fn()), getClient: () => db, isInTransaction: () => false };
    const repo = new PrismaAssistantActionRequestRepository(tx as ITransactionManager, prisma as unknown as PrismaService<PrismaClient>);
    const project = await db.project.create({ data: { name: 'Migrated links', slug: 'migrated-links', key: 'MIG' } });
    const thread = await db.chatThread.create({ data: { projectId: project.id, kind: 'REPO', title: 'Migrated', createdById: 'requester', backend: { kind: 'native', model: 'test' }, skills: [] } });
    const approval = await db.approvalRequest.create({ data: {
      permissionKey: 'comment.create', projectId: project.id, actorType: 'SYSTEM', actorId: 'assistant', origin: 'thread', correlationId: 'migration',
      input: {}, inputHash: 'hash', requiredMode: 'human', onTimeout: 'reject', approverMustHoldAction: true, requireDistinctApprover: false,
      status: 'pending', expiresAt: new Date(Date.now() + 60_000),
    } });
    const link = { requestId: approval.id, threadId: thread.id, jobId: 'job', toolCallId: 'call', tool: 'koda_add_comment', preview: 'p' };
    await repo.insert(link);
    expect(await repo.findByRequest(approval.id)).toMatchObject({ ...link, notedAt: null, deliveredAt: null, deliveredMessageId: null });
    await db.chatThread.delete({ where: { id: thread.id } });
    expect(await repo.findByRequest(approval.id)).toBeNull();
    expect(await db.approvalRequest.findUnique({ where: { id: approval.id } })).toMatchObject({ status: 'pending' });
  });
});

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

  async function request(status = 'pending', actorId = 'a1', requestProjectId = projectId) {
    return write(() => db.approvalRequest.create({ data: {
      permissionKey: 'ticket.comment', projectId: requestProjectId, actorType: 'AGENT', actorId, origin: 'thread', correlationId: randomUUID(),
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
    const otherProject = await write(() => db.project.create({ data: { name: 'Other project', slug: `other-${randomUUID()}`, key: randomUUID() } }));
    const wrongProject = await request('pending', 'a1', otherProject.id);
    for (const [r, target] of [[first, t], [second, t], [rejected, t], [foreign, other], [wrongProject, t]] as const) {
      await write(() => repo.insert({ requestId: r.id, threadId: target.id, jobId: null, toolCallId: null, tool: 'write', preview: 'p' }));
    }
    expect(await repo.countPendingInThread(t.id)).toBe(3);
    expect(await repo.findScopedInThread(first.id, projectId, t.id)).toMatchObject({ request: { status: 'pending' } });
    expect(await repo.findScopedInThread(foreign.id, projectId, t.id)).toBeNull();
    expect(await repo.findScopedInThread(wrongProject.id, projectId, t.id)).toBeNull();
    const ownWithoutLink = await request();
    expect(await repo.findOwnRequest(ownWithoutLink.id, projectId, { type: 'AGENT', id: 'a1' })).toMatchObject({ assistantAction: null });
    expect(await repo.findOwnRequest(first.id, projectId, { type: 'AGENT', id: 'a1' })).toMatchObject({ assistantAction: { requestId: first.id } });
    expect(await repo.findOwnRequest(first.id, projectId, { type: 'AGENT', id: 'a2' })).toBeNull();
  });
  it('deleting a thread cascades its link without deleting the approval request', async () => {
    const t = await thread();
    const approval = await request();
    await write(() => repo.insert({ requestId: approval.id, threadId: t.id, jobId: null, toolCallId: null, tool: 'write', preview: 'p' }));
    await write(() => db.chatThread.delete({ where: { id: t.id } }));
    expect(await repo.findByRequest(approval.id)).toBeNull();
    expect(await db.approvalRequest.findUnique({ where: { id: approval.id } })).toMatchObject({ id: approval.id, status: 'pending' });
  });

  it('writes notes in sequence and stores the noted mark; locks existing and missing rows', async () => {
    const t = await thread();
    await write(() => db.chatMessage.create({ data: { threadId: t.id, seq: 4, role: 'assistant', content: 'prior', status: 'complete' } }));
    const approval = await request();
    await write(() => repo.insert({ requestId: approval.id, threadId: t.id, jobId: null, toolCallId: null, tool: 'write', preview: 'p' }));
    const tx = app.get<ITransactionManager>(TRANSACTION_MANAGER);
    await write(() => tx.run(async () => {
      expect(await repo.lockThread(t.id)).toBe(true);
      expect(await repo.lockByRequest(approval.id)).toMatchObject({ requestId: approval.id });
    }));
    const id = await write(() => repo.insertSystemNote(t.id, 'note'));
    const note = await db.chatMessage.findUniqueOrThrow({ where: { id } });
    expect(note).toMatchObject({ content: 'note', role: 'system', seq: 5 });
    const at = new Date();
    await write(() => repo.markNoted(approval.id, id, at));
    expect(await repo.findByRequest(approval.id)).toMatchObject({ noteMessageId: id, notedAt: at });
    expect(await repo.lockThread(t.id)).toBe(true);
    expect(await repo.lockThread('missing')).toBe(false);
    expect(await repo.lockByRequest(approval.id)).toMatchObject({ requestId: approval.id });
    expect(await repo.lockByRequest('missing')).toBeNull();
  });
});
