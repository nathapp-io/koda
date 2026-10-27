import { randomUUID } from 'node:crypto';
import type { NathApplication } from '@nathapp/nestjs-app';
import { Logger } from '@nestjs/common';
import { TRANSACTION_MANAGER, type ITransactionManager } from '@nathapp/nestjs-data';
import { canRunDbTests } from '../../helpers/test-environment';
import { createTestPrismaClient } from '../../helpers/test-prisma';
import { resetDb } from '../../helpers/reset-db';
import { bootHttpApp } from '../../helpers/http-app';
import { withTestActor } from '../../helpers/action-context';
import { applyMigration, scratchSchemaBefore, type ScratchSchema } from '../../helpers/migration-schema';
import { isUniqueViolation } from '../../../src/common/utils/prisma-errors';
import { Prisma } from '../../../src/generated/prisma/client';
import { APPROVAL_POLICY_REPOSITORY, APPROVAL_REQUEST_REPOSITORY } from '../../../src/approvals/domain/approval.domain';
import { PrismaApprovalPolicyRepository } from '../../../src/approvals/prisma-approval-policy.repository';
import { PrismaApprovalRequestRepository } from '../../../src/approvals/prisma-approval-request.repository';
import { grantKeys } from '../../../src/approvals/test-helpers/approval-fixtures';
import { grantBaseline } from '../../../src/permissions/test-helpers/permission-fixtures';
import { PermissionService } from '../../../src/permissions/permission.service';

const describeDb = canRunDbTests() ? describe : describe.skip;
const write = <T>(fn: () => Promise<T>) => withTestActor({ type: 'USER', id: 'approval-test-user' }, fn);
const now = new Date('2026-11-04T12:00:00Z');
const policy = (selector = randomUUID()) => ({ selector, permissionPattern: 'ticket.delete', mode: 'agent', updatedByType: 'USER', updatedById: 'approval-test-user' });
const request = (patch: Partial<Prisma.ApprovalRequestCreateInput> = {}): Prisma.ApprovalRequestCreateInput => ({
  permissionKey: 'ticket.delete', projectId: 'p1', actorType: 'AGENT', actorId: 'a1',
  onBehalfOfType: 'USER', onBehalfOfId: 'u2', origin: 'rest', correlationId: 'c1', input: { id: 't1' }, inputHash: 'hash',
  requiredMode: 'human', onTimeout: 'reject', approverMustHoldAction: true, requireDistinctApprover: false,
  expiresAt: new Date(now.getTime() + 1000), ...patch,
});

// Migration behavior uses an isolated schema, not db push.
describeDb('approval engine migration', () => {
  let scratch: ScratchSchema;
  const schema = `approval_${randomUUID().replaceAll('-', '')}`;
  beforeAll(async () => {
    scratch = await scratchSchemaBefore(process.env.DATABASE_URL as string, schema, '20261104090000_approval_engine');
    await applyMigration(scratch.db, '20261104090000_approval_engine');
    // The generated client knows every column the later migrations add, so the scratch schema must
    // carry them too or a create on this table sends a column the schema does not have.
    await applyMigration(scratch.db, '20261106090000_approval_fleet_core');
  }, 60_000);
  afterAll(async () => { await scratch?.drop(); });
  it('AC-1: creates every model column and the unique selector index', async () => {
    const expected = {
      ApprovalPolicy: 'id selector projectId permissionPattern principalType roleId principalId mode timeoutSec onTimeout requiredApprovals approverMustHoldAction requireDistinctApprover updatedByType updatedById createdAt updatedAt',
      ApprovalRequest: 'id permissionKey projectId actorType actorId onBehalfOfType onBehalfOfId origin correlationId input inputHash requiredMode policyId onTimeout approverMustHoldAction requireDistinctApprover status satisfiedBy approverType approverId expiresAt decidedAt settledAt result createdAt updatedAt',
      ApprovalDecision: 'id requestId deciderType deciderId decision comment decidedAt params',
    };
    for (const [table, names] of Object.entries(expected)) {
      const columns = await scratch.db.$queryRaw<Array<{ column_name: string }>>`SELECT column_name FROM information_schema.columns WHERE table_schema = ${schema} AND table_name = ${table} ORDER BY ordinal_position`;
      expect(columns.map((c) => c.column_name)).toEqual(names.split(' '));
    }
    const indexes = await scratch.db.$queryRaw<Array<{ indexdef: string }>>`SELECT indexdef FROM pg_indexes WHERE schemaname = ${schema} AND indexname = 'ApprovalPolicy_selector_key'`;
    expect(indexes).toHaveLength(1);
    expect(indexes[0].indexdef).toContain('UNIQUE INDEX');
    expect(indexes[0].indexdef).toContain('(selector)');
  });
  it('AC-2: duplicate selectors are recognized by isUniqueViolation', async () => {
    await write(() => scratch.db.approvalPolicy.create({ data: policy('same') }));
    let caught: unknown;
    try { await write(() => scratch.db.approvalPolicy.create({ data: policy('same') })); } catch (error) { caught = error; }
    expect(isUniqueViolation(caught, 'selector')).toBe(true);
  });
  it('AC-3: deletes decisions with their request', async () => {
    const row = await write(() => scratch.db.approvalRequest.create({ data: request() }));
    await write(() => scratch.db.approvalDecision.create({ data: { requestId: row.id, deciderType: 'USER', deciderId: 'u1', decision: 'approve' } }));
    await write(() => scratch.db.approvalRequest.delete({ where: { id: row.id } }));
    expect(await scratch.db.approvalDecision.count({ where: { requestId: row.id } })).toBe(0);
  });
});

describeDb('approval repositories through AppModule', () => {
  const db = createTestPrismaClient();
  let app: NathApplication;
  let policies: PrismaApprovalPolicyRepository;
  let requests: PrismaApprovalRequestRepository;
  let tx: ITransactionManager;
  beforeAll(async () => {
    await resetDb();
    await write(async () => {
      const user = await db.user.create({ data: { id: 'approval-test-user', email: 'approval-test@example.test', passwordHash: 'test-only' } });
      await grantBaseline(db, { type: 'USER', id: user.id });
    });
    app = await bootHttpApp({ registrationEnabled: false });
    policies = app.get(APPROVAL_POLICY_REPOSITORY, { strict: false });
    requests = app.get(APPROVAL_REQUEST_REPOSITORY, { strict: false });
    tx = app.get(TRANSACTION_MANAGER);
  });
  afterAll(async () => { await app?.close(); await db.$disconnect(); });
  beforeEach(async () => { await write(async () => { await db.approvalRequest.deleteMany(); await db.approvalPolicy.deleteMany(); }); });
  const create = (patch: Partial<Prisma.ApprovalRequestCreateInput> = {}) => write(() => db.approvalRequest.create({ data: request(patch) }));
  const match = { actorType: 'AGENT' as const, actorId: 'a1', onBehalfOfType: 'USER' as const, onBehalfOfId: 'u2', permissionKey: 'ticket.delete', projectId: 'p1', inputHash: 'hash' };
  it('AC-4: matches exact keys and dot-bounded prefixes only in this project or globally', async () => {
    const expected: string[] = [];
    for (const projectId of ['p1', 'p2', null]) for (const pattern of ['ticket.delete', 'ticket.*', 'ti.*', 'ticket.update', 'comment.*']) {
      const row = await write(() => db.approvalPolicy.create({ data: { ...policy(), projectId, permissionPattern: pattern } }));
      if (projectId !== 'p2' && ['ticket.delete', 'ticket.*'].includes(pattern)) expected.push(row.id);
    }
    expect((await policies.findCandidates('ticket.delete', 'p1')).map((r) => r.id).sort()).toEqual(expected.sort());
  });
  it('AC-5: matches the full duplicate identity, pending state and strict future expiry', async () => {
    const row = await create();
    expect((await requests.findPendingDuplicate(match, now))?.id).toBe(row.id);
    for (const patch of [{ status: 'rejected' }, { status: 'pending', expiresAt: now }, { expiresAt: new Date(now.getTime() - 1) }, { expiresAt: new Date(now.getTime() + 1000), onBehalfOfId: 'other' }]) {
      await write(() => db.approvalRequest.update({ where: { id: row.id }, data: patch }));
      expect(await requests.findPendingDuplicate(match, now)).toBeNull();
    }
    await write(() => db.approvalRequest.update({ where: { id: row.id }, data: { onBehalfOfType: null, onBehalfOfId: null } }));
    expect((await requests.findPendingDuplicate({ ...match, onBehalfOfType: null, onBehalfOfId: null }, now))?.id).toBe(row.id);
  });
  it('AC-6: returns only due pending requests oldest first', async () => {
    const older = await create({ expiresAt: new Date(now.getTime() - 1000) });
    const due = await create({ expiresAt: now });
    await create(); await create({ status: 'approved', expiresAt: new Date(now.getTime() - 1000) });
    expect((await requests.findDue(now, 10)).map((r) => r.id)).toEqual([older.id, due.id]);
    expect(await requests.findDue(now, 1)).toHaveLength(1);
  });
  it('AC-7: conditionally transitions a pending row', async () => {
    const row = await create();
    expect(await write(() => tx.run(() => requests.transition(row.id, 'pending', { status: 'approved' })))).toMatchObject({ id: row.id, status: 'approved' });
  });
  it('AC-8: leaves a non-matching status unchanged', async () => {
    const row = await create({ status: 'approved' });
    expect(await write(() => tx.run(() => requests.transition(row.id, 'pending', { status: 'rejected' })))).toBeNull();
    expect((await db.approvalRequest.findUniqueOrThrow({ where: { id: row.id } })).status).toBe('approved');
  });
  it('AC-9: round trips decision fields in oldest-first order with a 50-row cap', async () => {
    const row = await create();
    const input = { requestId: row.id, deciderType: 'USER' as const, deciderId: 'u1', decision: 'approve' as const, comment: 'yes' };
    const decision = await write(() => requests.createDecision(input));
    expect(await requests.findDecisions(row.id)).toEqual([expect.objectContaining({ ...input, id: decision.id })]);
    await write(() => db.approvalDecision.createMany({ data: Array.from({ length: 51 }, (_, i) => ({ ...input, decidedAt: new Date(now.getTime() + i) })) }));
    const found = await requests.findDecisions(row.id);
    expect(found).toHaveLength(50);
    expect(found.map((d) => d.decidedAt.getTime())).toEqual([...found.map((d) => d.decidedAt.getTime())].sort((a, b) => a - b));
  });
  it('AC-10: locks and loads a request within the ambient transaction', async () => {
    const row = await create();
    await write(() => tx.run(async () => {
      expect(await requests.lockById(row.id)).toMatchObject({ id: row.id, actor: { type: row.actorType, id: row.actorId }, onBehalfOf: { type: 'USER', id: 'u2' }, input: { id: 't1' } });
      expect(await requests.lockById('missing')).toBeNull();
    }));
  });
  it('AC-13: grants exactly the requested keys in project and global scopes', async () => {
    const project = await write(() => db.project.create({ data: { slug: `approval-${randomUUID()}`, key: randomUUID(), name: 'Approval test' } }));
    const agents = await write(() => Promise.all([1, 2].map(() => db.agent.create({ data: { name: 'Approval test', slug: randomUUID(), apiKeyHash: randomUUID() } }))));
    const [a, b] = agents.map((agent) => ({ type: 'AGENT' as const, id: agent.id }));
    await write(async () => {
      await grantBaseline(db, a); await grantBaseline(db, b);
      await grantKeys(db, a, ['label.delete'], project.id); await grantKeys(db, b, ['role.manage'], null);
    });
    const permissions = app.get(PermissionService);
    const keys = await permissions.effectiveKeys(a, { projectId: project.id });
    expect(keys.has('label.delete')).toBe(true); expect(keys.has('label.update')).toBe(false);
    expect((await permissions.effectiveKeys(b, 'global')).has('role.manage')).toBe(true);
  });
  it('bounds policy candidates and warns at the cap', async () => {
    const warn = vi.spyOn(Logger.prototype, 'warn');
    warn.mockClear();
    try {
      await write(() => db.approvalPolicy.createMany({ data: Array.from({ length: 501 }, (_, i) => ({ ...policy(`cap-${i}`), projectId: 'p1' })) }));
      expect(await policies.findCandidates('ticket.delete', 'p1')).toHaveLength(500);
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('cap reached'));
    } finally { warn.mockRestore(); }
  });
  it('round trips policy persistence, selector lookup and filtered pagination', async () => {
    const row = await write(() => db.approvalPolicy.create({ data: policy() }));
    const domain = await policies.findBySelector(row.selector);
    expect(domain).toMatchObject({ id: row.id, mode: 'agent' });
    expect(await policies.findBySelector('missing')).toBeNull();
    if (!domain) throw new Error('missing policy');
    const copy = await write(() => policies.create({ ...domain, id: randomUUID(), selector: 'copy' }));
    await write(() => policies.update(copy.id, { projectId: 'p1', mode: 'human' }));
    const page = await policies.findPage({ projectId: 'p1', permissionPattern: 'ticket.delete' }, { current: 1, size: 1 });
    expect(page.records).toEqual([expect.objectContaining({ id: copy.id, mode: 'human' })]);
    expect((await policies.findPage({ projectId: null }, { current: 1, size: 1 })).records).toHaveLength(1);
  });
  it('maps domain creates and partial updates, including JSON and nullable actors', async () => {
    const row = await create();
    const domain = await requests.findById(row.id);
    if (!domain) throw new Error('missing request');
    const copy = await write(() => requests.create({ ...domain, id: randomUUID(), input: null, result: { answer: 1 }, onBehalfOf: null }));
    expect(copy).toMatchObject({ input: null, result: { answer: 1 }, onBehalfOf: null });
    const updated = await write(() => requests.update(copy.id, { actor: { type: 'SYSTEM', id: 'assistant' }, onBehalfOf: { type: 'AGENT', id: 'a2' }, result: null }));
    expect(updated).toMatchObject({ actor: { type: 'SYSTEM', id: 'assistant' }, onBehalfOf: { type: 'AGENT', id: 'a2' }, result: null, input: null });
    await write(() => requests.update(copy.id, { onBehalfOf: null }));
    expect((await requests.findById(copy.id))?.onBehalfOf).toBeNull();
    expect(await requests.findPendingDuplicate({ ...match, projectId: 'other' }, now)).toBeNull();
    expect(await requests.findPendingDuplicate({ ...match, onBehalfOfType: 'AGENT' }, now)).toBeNull();
  });
  it('joins ambient transactions and rolls back transitions and decisions together', async () => {
    const row = await create();
    await expect(write(() => tx.run(async () => {
      await requests.transition(row.id, 'pending', { status: 'approved' });
      await requests.createDecision({ requestId: row.id, deciderType: 'USER', deciderId: 'u1', decision: 'approve' });
      throw new Error('rollback probe');
    }))).rejects.toThrow('rollback probe');
    expect((await requests.findById(row.id))?.status).toBe('pending');
    expect(await requests.findDecisions(row.id)).toEqual([]);
  });
  it('rejects invalid grant entries before creating a role', async () => {
    const count = await db.role.count();
    await expect(write(() => grantKeys(db, { type: 'AGENT', id: 'a1' }, ['invalid.permission'], null))).rejects.toThrow();
    expect(await db.role.count()).toBe(count);
  });
  it('AC-15: AppModule registers the request repository', () => {
    expect(app.get(APPROVAL_REQUEST_REPOSITORY, { strict: false })).toBeInstanceOf(PrismaApprovalRequestRepository);
    expect(policies).toBeInstanceOf(PrismaApprovalPolicyRepository);
  });
});
