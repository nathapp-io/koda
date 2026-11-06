import { Logger } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { TRANSACTION_MANAGER, type ITransactionManager } from '@nathapp/nestjs-data';
import type { NathApplication } from '@nathapp/nestjs-app';
import type { PrismaClient } from '../../src/generated/prisma/client';
import { FleetFlowsService } from '../../src/fleet/flows/fleet-flows.service';
import { FleetFlowStartCommand } from '../../src/fleet/flows/fleet-flow-start.command';
import { PrismaThreadIngestRepository } from '../../src/fleet/threads/ingest/prisma-thread-ingest.repository';
import type { ThreadIngestBatch } from '../../src/fleet/threads/ingest/domain/thread-ingest.domain';
import type { ThreadLine } from '../../src/fleet/threads/ingest/thread-line';
import { BudgetEvaluator } from '../../src/fleet/budgets/budget-evaluator';
import { ApprovalAskService } from '../../src/approvals/approval-ask.service';
import { runWithActionContext } from '../../src/action-context/action-context';
import { fixtureDb, withTestActor } from '../helpers/action-context';
import { insertRunner, seedFleetBase } from '../helpers/fleet-fixtures';
import { bootHttpApp } from '../helpers/http-app';
import { resetDb } from '../helpers/reset-db';
import { canRunDbTests } from '../helpers/test-environment';

const integration = canRunDbTests() ? describe : describe.skip;
const OLD = 'a'.repeat(40);
const NEW = 'b'.repeat(40);
const PATH = '.nax/features/flow/spec.md';
const EVENT = 'thread.spec.published';
const pendingRequestId = (flow: { approvalRequestId: string | null }): string => {
  if (flow.approvalRequestId === null) throw new Error('fixture flow has no pending request');
  return flow.approvalRequestId;
};

integration('thread publication -> flow respec', () => {
  let app: NathApplication;
  let db: PrismaClient;
  let service: FleetFlowsService;
  let emitter: EventEmitter2;
  let emitters: EventEmitter2[];
  let ingest: PrismaThreadIngestRepository;
  let tx: ITransactionManager;
  let projectId: string;
  let repoId: string;
  let runnerId: string;
  let creatorId: string;
  let threadId: string;
  let jobId: string;
  const spies: Array<{ mockRestore(): void }> = [];
  const listeners: Array<(event: { threadId: string; sha: string; paths: string[] }) => unknown> = [];
  const spy = <T extends { mockRestore(): void }>(s: T): T => { spies.push(s); return s; };
  // The full AppFactory app has more than one EventEmitterModule instance; observe all concrete
  // emitters rather than assuming app.get's last match is the ingest module's injected instance.
  const listen = (fn: (event: { threadId: string; sha: string; paths: string[] }) => unknown) => { listeners.push(fn); for (const e of emitters) e.on(EVENT, fn); };
  const fold = (lines: ThreadLine[], id = jobId, endOffset = 100) => withTestActor({ type: 'SYSTEM', id: 'thread' }, () => ingest.fold({
    jobId: id, leaseEpoch: 1, endOffset, badLines: 0,
    lines: lines.map((line, i) => ({ line, endOffset: i + 1 })),
  } satisfies ThreadIngestBatch));
  const published = (paths = [PATH]): ThreadLine => ({ type: 'published', sha: NEW, paths, ignored: ['ignored.txt'], specPresent: true });
  const create = async (approved = false) => {
    if (approved) await db.chatThread.update({ where: { id: threadId }, data: { preApproval: { userId: creatorId, at: new Date().toISOString(), costCapUsd: '30' } } });
    return (await withTestActor({ type: 'USER', id: creatorId }, () => service.create({ entry: 'THREAD', threadId, features: [{ feature: 'flow', specPath: PATH, dependsOn: [] }], roles: { reviewer: 'acp:claude', supervisor: 'native:fast' }, costCapUsd: '25' }, { type: 'USER', id: creatorId }, { projectId }))).flow;
  };
  const publishEvent = async (paths = [PATH], sha = NEW, continuity = true) => {
    await db.chatThread.update({ where: { id: threadId }, data: { publishedSha: NEW } });
    await emitter.emitAsync(EVENT, { threadId, sha, paths, ...(continuity ? { previousSha: OLD } : {}) });
  };
  const requests = () => db.approvalRequest.findMany({ where: { permissionKey: 'fleet.flow.start', status: 'pending' } });

  beforeAll(async () => {
    vi.stubEnv('FLEET_THREADS_ENABLED', 'true');
    await resetDb();
    app = await bootHttpApp({ registrationEnabled: false });
    db = fixtureDb(app);
    const base = await seedFleetBase(db);
    ({ projectId, repoId } = base);
    creatorId = base.adminId;
    runnerId = (await insertRunner(db)).id;
    service = app.get(FleetFlowsService);
    emitter = app.get(EventEmitter2);
    ingest = app.get(PrismaThreadIngestRepository, { strict: false });
    tx = app.get(TRANSACTION_MANAGER);
    emitters = [...new Set(app.get(EventEmitter2, { each: true }))];
  }, 60_000);
  afterAll(async () => { try { await app?.close(); } finally { vi.unstubAllEnvs(); } });
  beforeEach(async () => {
    await db.approvalDecision.deleteMany();
    await db.approvalRequest.deleteMany();
    await db.fleetFlowFeature.deleteMany();
    await db.fleetFlow.deleteMany();
    await db.auditEntry.deleteMany({ where: { key: 'system.flow.respec' } });
    await db.fleetActivity.deleteMany({ where: { action: 'flow.respec' } });
    await db.fleetJob.deleteMany({ where: { projectId } });
    await db.chatThread.deleteMany({ where: { projectId } });
    const thread = await db.chatThread.create({ data: { projectId, repoId, title: 'respec', createdById: creatorId, backend: { kind: 'native', model: 'm1' }, skills: [], feature: 'flow', specPath: PATH, baseRef: 'main', runnerId, publishedSha: OLD, specPublished: true, writtenPaths: [PATH] } });
    threadId = thread.id;
    jobId = (await db.fleetJob.create({ data: { projectId, repoId, runnerId, threadId, command: 'THREAD', feature: 'flow', ref: 'main', profiles: [], selectorLabels: [], maxCostUsd: '10', requestedById: creatorId, state: 'RUNNING', leaseEpoch: 1 } })).id;
  });
  afterEach(() => {
    for (const fn of listeners.splice(0)) for (const e of emitters) e.off(EVENT, fn);
    for (const s of spies.splice(0)) s.mockRestore();
  });

  it('AC-1: publishes once with job threadId after the transaction commits', async () => {
    const received: unknown[] = [];
    listen(async (event) => {
      received.push({ event, inTransaction: tx.isInTransaction(), sha: (await db.chatThread.findUniqueOrThrow({ where: { id: threadId } })).publishedSha });
    });
    await fold([published()]);
    expect(received).toEqual([{ event: { threadId, sha: NEW, paths: [PATH], previousSha: OLD }, inTransaction: false, sha: NEW }]);
  });
  it('AC-2: write_doc only emits nothing', async () => {
    const received = vi.fn(); listen(received);
    await fold([{ type: 'write_doc', path: PATH, bytes: 10 }]);
    expect(received).not.toHaveBeenCalled();
  });
  it('AC-3: real ingest and listener return touched APPROVED to PENDING and clear approval', async () => {
    const flow = await create(true);
    await fold([published()]);
    const row = await db.fleetFlow.findUniqueOrThrow({ where: { id: flow.id } });
    expect(row).toMatchObject({ state: 'PENDING', specSha: NEW, approvalMode: null, approverId: null, approvedAt: null });
    expect(await requests()).toMatchObject([{ id: row.approvalRequestId, input: { flowId: flow.id, specSha: NEW }, onBehalfOfType: 'USER', onBehalfOfId: creatorId, origin: 'system' }]);
  });
  it.each(['./docs/spec.md', 'docs//spec.md', 'docs/./spec.md'])('AC-3/B1: a legacy stored alias %s cannot retain approval after the canonical spec changes', async (specPath) => {
    const flow = await create(true);
    // Simulate rows written before canonicalization; new writes must not be the only protection.
    await db.fleetFlowFeature.updateMany({ where: { flowId: flow.id }, data: { specPath } });
    await fold([published(['docs/spec.md'])]);
    const row = await db.fleetFlow.findUniqueOrThrow({ where: { id: flow.id } });
    expect(row).toMatchObject({ state: 'PENDING', specSha: NEW, approvalMode: null, approverId: null, approvedAt: null });
    expect(await requests()).toMatchObject([{ id: row.approvalRequestId, input: { flowId: flow.id, specSha: NEW } }]);
  });
  it('F1: a spec publication followed by an unrelated publication in one fold must re-ask at the final sha', async () => {
    const flow = await create(true);
    const finalSha = 'c'.repeat(40);
    const events: unknown[] = [];
    listen((event) => { events.push(event); });
    await fold([published(), { type: 'published', sha: finalSha, paths: ['docs/other.md'], ignored: [], specPresent: true }]);
    expect(events).toEqual([
      { threadId, sha: NEW, paths: [PATH], previousSha: OLD },
      { threadId, sha: finalSha, paths: ['docs/other.md'], previousSha: NEW },
    ]);
    const current = await db.fleetFlow.findUniqueOrThrow({ where: { id: flow.id } });
    expect(current).toMatchObject({
      state: 'PENDING', specSha: finalSha, approvalMode: null, approverId: null, approvedAt: null,
    });
    expect(await requests()).toMatchObject([{ id: current.approvalRequestId, input: { flowId: flow.id, specSha: finalSha } }]);
    expect((await db.chatThread.findUniqueOrThrow({ where: { id: threadId } })).publishedSha).toBe(finalSha);
  });
  it('F1: a lost spec publication cannot be hidden by an unrelated publication in a later fold', async () => {
    const flow = await create(true);
    const open = spy(vi.spyOn(app.get(ApprovalAskService), 'open')).mockRejectedValueOnce(new Error('lost respec'));
    await fold([published()]);
    expect(open).toHaveBeenCalledOnce();
    expect((await db.fleetFlow.findUniqueOrThrow({ where: { id: flow.id } })).specSha).toBe(OLD);
    const finalSha = 'c'.repeat(40);
    await fold([{ type: 'published', sha: finalSha, paths: ['docs/other.md'], ignored: [], specPresent: true }], jobId, 200);
    expect(await db.fleetFlow.findUniqueOrThrow({ where: { id: flow.id } })).toMatchObject({ state: 'PENDING', specSha: finalSha });
    expect(await requests()).toMatchObject([{ input: { flowId: flow.id, specSha: finalSha } }]);
  });
  it('F1: a single unrelated publication still preserves approval when ingest establishes continuity', async () => {
    const flow = await create(true);
    await fold([published(['docs/other.md'])]);
    expect(await db.fleetFlow.findUniqueOrThrow({ where: { id: flow.id } })).toMatchObject({
      state: 'APPROVED', specSha: NEW, approvalMode: flow.approvalMode, approverId: flow.approverId, approvedAt: flow.approvedAt,
    });
    expect(await requests()).toHaveLength(0);
  });
  it('F1: an unrelated legacy event without continuity evidence conservatively re-asks', async () => {
    const flow = await create(true);
    await publishEvent(['docs/other.md'], NEW, false);
    expect(await db.fleetFlow.findUniqueOrThrow({ where: { id: flow.id } })).toMatchObject({ state: 'PENDING', specSha: NEW });
    expect(await requests()).toMatchObject([{ input: { flowId: flow.id, specSha: NEW } }]);
  });
  it.each([['AC-4', [PATH]], ['AC-5', ['docs/unrelated.md']]] as const)('%s: PENDING re-asks regardless of touched paths', async (_ac, paths) => {
    const flow = await create();
    await publishEvent([...paths]);
    expect(await db.approvalRequest.findUniqueOrThrow({ where: { id: pendingRequestId(flow) } })).toMatchObject({ status: 'cancelled', result: { closedBy: 'superseded' } });
    const row = await db.fleetFlow.findUniqueOrThrow({ where: { id: flow.id } });
    expect(row.approvalRequestId).not.toBe(flow.approvalRequestId);
    expect(await requests()).toMatchObject([{ id: row.approvalRequestId, input: { flowId: flow.id, specSha: NEW } }]);
  });
  it('AC-6: untouched APPROVED keeps approval columns and takes the new sha', async () => {
    const flow = await create(true);
    await publishEvent(['docs/unrelated.md']);
    expect(await db.fleetFlow.findUniqueOrThrow({ where: { id: flow.id } })).toMatchObject({ state: 'APPROVED', specSha: NEW, approvalMode: flow.approvalMode, approverId: flow.approverId, approvedAt: flow.approvedAt, approvalRequestId: flow.approvalRequestId });
    expect(await requests()).toHaveLength(0);
  });
  it('AC-7: a stale event writes nothing', async () => {
    const flow = await create();
    await publishEvent([PATH], 'c'.repeat(40));
    expect(await db.fleetFlow.findUniqueOrThrow({ where: { id: flow.id } })).toMatchObject({ updatedAt: flow.updatedAt, specSha: OLD, approvalRequestId: flow.approvalRequestId });
    expect(await db.auditEntry.count({ where: { key: 'system.flow.respec' } })).toBe(0);
    expect(await db.fleetActivity.count({ where: { action: 'flow.respec' } })).toBe(0);
  });
  it('AC-8: duplicate delivery changes once and leaves one open ask', async () => {
    await create();
    await publishEvent(); await publishEvent();
    expect(await requests()).toHaveLength(1);
    expect(await db.approvalRequest.count({ where: { permissionKey: 'fleet.flow.start' } })).toBe(2);
    expect(await db.auditEntry.count({ where: { key: 'system.flow.respec' } })).toBe(1);
  });
  it('AC-9: no live flow writes nothing and does not throw', async () => {
    await publishEvent();
    expect(await db.fleetFlow.count()).toBe(0);
    expect(await requests()).toHaveLength(0);
    expect(await db.auditEntry.count({ where: { key: 'system.flow.respec' } })).toBe(0);
    expect(await db.fleetActivity.count({ where: { action: 'flow.respec' } })).toBe(0);
  });
  it.each([false, true])('AC-10/11: every applied respec audits SYSTEM and records project-scoped activity (untouched approved=%s)', async (approved) => {
    const flow = await create(approved);
    await publishEvent(approved ? ['docs/unrelated.md'] : [PATH]);
    expect(await db.auditEntry.findMany({ where: { key: 'system.flow.respec' } })).toMatchObject([{ actorType: 'SYSTEM', key: 'system.flow.respec', resourceType: 'flow', resourceId: flow.id, projectId }]);
    expect(await db.fleetActivity.findMany({ where: { action: 'flow.respec' } })).toMatchObject([{ projectId, entityType: 'flow', entityId: flow.id, payload: { flowId: flow.id, state: approved ? 'APPROVED' : 'PENDING' } }]);
  });
  it('AC-12: late approval of a held old ask cannot approve the re-asked flow', async () => {
    const flow = await create();
    // Simulate SKIP LOCKED close: the old decider already owns the request row.
    const close = spy(vi.spyOn(app.get(ApprovalAskService), 'close')).mockResolvedValue(null);
    await publishEvent();
    expect(close).toHaveBeenCalledWith(pendingRequestId(flow), { status: 'cancelled', reason: 'superseded' }, expect.any(Date));
    const result = await runWithActionContext({ actor: { type: 'USER', id: creatorId }, origin: 'rest', approval: { requiredMode: 'human', satisfiedBy: 'human', approverId: creatorId, requestId: pendingRequestId(flow) } }, () => tx.run(() => app.get(FleetFlowStartCommand).execute({ flowId: flow.id, specSha: OLD })));
    expect(result).toEqual({ applied: false });
    expect((await db.fleetFlow.findUniqueOrThrow({ where: { id: flow.id } })).state).toBe('PENDING');
  });
  it('AC-13/14: listener failure is logged without losing published metadata or the fold result', async () => {
    const log = vi.mocked(Logger.prototype.error); log.mockClear();
    listen(() => { throw new Error('respec listener exploded'); });
    const result = await fold([published()]);
    expect(log).toHaveBeenCalledWith(expect.stringContaining('respec listener exploded'));
    expect(result).toMatchObject({ costChanged: false, events: [expect.objectContaining({ type: 'thread', threadId })] });
    expect(await db.chatThread.findUniqueOrThrow({ where: { id: threadId } })).toMatchObject({ publishedSha: NEW, specPublished: true, writtenPaths: [], lastWrite: { kind: 'published', jobId, sha: NEW, paths: [PATH], ignored: ['ignored.txt'] } });
  });
  it('AC-13: a real respec listener failure rolls back only the flow transaction', async () => {
    const flow = await create();
    const open = spy(vi.spyOn(app.get(ApprovalAskService), 'open')).mockRejectedValue(new Error('respec ask failed'));
    const log = vi.mocked(Logger.prototype.error); log.mockClear();
    const result = await fold([published()]);
    expect(open).toHaveBeenCalledOnce();
    expect(log).toHaveBeenCalledWith(expect.stringContaining('respec ask failed'));
    expect(result.events).toContainEqual(expect.objectContaining({ type: 'thread', threadId }));
    expect((await db.chatThread.findUniqueOrThrow({ where: { id: threadId } })).publishedSha).toBe(NEW);
    expect(await db.fleetFlow.findUniqueOrThrow({ where: { id: flow.id } })).toMatchObject({ specSha: OLD, approvalRequestId: flow.approvalRequestId, state: 'PENDING' });
    expect(await requests()).toMatchObject([{ id: flow.approvalRequestId, status: 'pending' }]);
    expect(await db.auditEntry.count({ where: { key: 'system.flow.respec' } })).toBe(0);
    expect(await db.fleetActivity.count({ where: { action: 'flow.respec' } })).toBe(0);
  });
  it('AC-14: missing job is an empty fold without emission', async () => {
    const received = vi.fn(); listen(received);
    expect(await fold([published()], 'missing-job')).toEqual({ costChanged: false, events: [] });
    expect(received).not.toHaveBeenCalled();
  });
  it('AC-15: priced usage retains cost derivation, cursor and after-commit budget signal', async () => {
    await db.chatMessage.create({ data: { threadId, seq: 1, role: 'assistant', status: 'streaming', content: '', jobId, turnId: 'turn' } });
    const signal = spy(vi.spyOn(app.get(BudgetEvaluator), 'signal')).mockImplementation(() => { expect(tx.isInTransaction()).toBe(false); });
    const result = await fold([{ type: 'usage', turnId: 'turn', round: 1, inputTokens: 1, outputTokens: 1, cacheRead: 0, cacheWrite: 0, costUsd: 0.25 }], jobId, 123);
    expect(result.costChanged).toBe(true);
    expect(await db.threadIngestCursor.findUniqueOrThrow({ where: { jobId_leaseEpoch: { jobId, leaseEpoch: 1 } } })).toMatchObject({ offset: 123n });
    expect((await db.fleetJob.findUniqueOrThrow({ where: { id: jobId } })).costSpentUsd.toString()).toBe('0.25');
    expect(signal).toHaveBeenCalledWith(['global', `project:${projectId}`, `repo:${repoId}`, `runner:${runnerId}`]);
  });
});
