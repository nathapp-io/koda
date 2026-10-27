import { randomUUID } from 'node:crypto';
import type { NathApplication } from '@nathapp/nestjs-app';
import { ApprovalRequestQueries } from '../../../src/approvals/approval-request.queries';
import { ApprovalGate } from '../../../src/approvals/approval-gate.service';
import { ApprovalCommandRegistry } from '../../../src/approvals/approval-command.registry';
import { ApprovalRequestNotFoundError } from '../../../src/approvals/domain/approval.errors';
import { grantKeys } from '../../../src/approvals/test-helpers/approval-fixtures';
import { configurableTestCommand } from '../../../src/approvals/test-helpers/test-approval-command';
import { grantRole } from '../../../src/permissions/test-helpers/permission-fixtures';
import { PermissionService } from '../../../src/permissions/permission.service';
import { PermissionCache } from '../../../src/permissions/permission-cache';
import type { PrincipalRef } from '../../../src/permissions/permissions.types';
import { fixtureDb, withTestActor } from '../../helpers/action-context';
import { bootHttpApp } from '../../helpers/http-app';
import { resetDb } from '../../helpers/reset-db';
import { canRunDbTests } from '../../helpers/test-environment';

(canRunDbTests() ? describe : describe.skip)('Approval request visibility through AppModule', () => {
  let app: NathApplication;
  let db: ReturnType<typeof fixtureDb>;
  let queries: ApprovalRequestQueries;
  let permissions: PermissionService;
  let actor: PrincipalRef;
  let approver: PrincipalRef;
  let narrowed: PrincipalRef;
  let global: PrincipalRef;
  let owner: PrincipalRef;
  let outsider: PrincipalRef;
  let p: string;
  let q: string;
  const labels = configurableTestCommand('label.delete');
  const page = { current: 1, size: 20 };
  const now = new Date();
  const open = async (projectId: string) => {
    const result = await withTestActor(actor, () => app.get(ApprovalGate, { strict: false }).gate(
      'label.delete', { labelId: randomUUID() }, { projectId }, now,
    ));
    if (result.status !== 'pending') throw new Error('expected pending request');
    return result.request;
  };
  const insert = (permissionKey: string, projectId: string | null) => db.approvalRequest.create({ data: {
    permissionKey, projectId, actorType: actor.type, actorId: actor.id, origin: 'rest', correlationId: randomUUID(),
    input: {}, inputHash: randomUUID(), requiredMode: 'human', onTimeout: 'reject',
    approverMustHoldAction: true, requireDistinctApprover: false, expiresAt: new Date(Date.now() + 86_400_000),
  } });
  const ids = async (principal: PrincipalRef, filter: Parameters<ApprovalRequestQueries['list']>[1] = {}) =>
    (await queries.list(principal, filter, page)).records.map((row) => row.id);
  const expectIds = async (principal: PrincipalRef, expected: string[], filter: Parameters<ApprovalRequestQueries['list']>[1] = {}) =>
    expect((await ids(principal, filter)).sort()).toEqual([...expected].sort());

  beforeAll(async () => {
    await resetDb();
    app = await bootHttpApp({ registrationEnabled: false });
    db = fixtureDb(app);
    queries = app.get(ApprovalRequestQueries, { strict: false });
    permissions = app.get(PermissionService, { strict: false });
    app.get(ApprovalCommandRegistry, { strict: false }).register(labels.command);
  });
  afterAll(async () => { await app?.close(); });
  beforeEach(async () => {
    labels.reset();
    await db.approvalDecision.deleteMany();
    await db.approvalRequest.deleteMany();
    await db.approvalPolicy.deleteMany();
    actor = { type: 'AGENT', id: randomUUID() };
    [approver, narrowed, global, owner, outsider] = Array.from({ length: 5 }, () => ({ type: 'USER' as const, id: randomUUID() }));
    p = randomUUID(); q = randomUUID();
    for (const id of [p, q]) await db.project.create({ data: { id, slug: `visibility-${id}`, key: id, name: id } });
    await grantRole(db, approver, 'approver', p);
    await grantKeys(db, approver, ['label.delete'], p);
    await grantKeys(db, narrowed, ['approval.decide@label.*'], p);
    await grantKeys(db, global, ['approval.decide'], null);
    await grantRole(db, owner, 'owner', null);
    for (const projectId of [p, q]) await grantKeys(db, actor, ['label.delete'], projectId);
    await app.get(PermissionCache, { strict: false }).invalidate();
  });

  it('AC-2: seeded project approver has only P decide scope', async () => {
    expect(await permissions.approvalDecideScopes(approver)).toEqual({ everywhere: false, global: [], projects: [{ projectId: p, patterns: 'all' }] });
  });
  it('AC-3: narrowed decide keys preserve their pattern', async () => {
    expect((await permissions.approvalDecideScopes(narrowed)).projects).toEqual([{ projectId: p, patterns: ['label.*'] }]);
  });
  it('AC-4: a non-admin global decider has global all and no project bindings', async () => {
    expect(await permissions.approvalDecideScopes(global)).toEqual({ everywhere: false, global: 'all', projects: [] });
  });
  it('AC-5: project approver sees only P requests', async () => {
    const first = await open(p); const second = await open(p); await open(q);
    await expectIds(approver, [first.id, second.id]);
  });
  it('AC-6: narrowed project decider sees label.delete but not ticket.delete', async () => {
    const request = await open(p); await insert('ticket.delete', p); await open(q);
    await expectIds(narrowed, [request.id]);
  });
  it('AC-7: global decide applies both without a project and in P', async () => {
    const request = await open(p); const globalRequest = await insert('role.manage', null);
    await expectIds(global, [request.id, globalRequest.id]);
  });
  it('AC-8: actor with no decide key sees its own request', async () => {
    const request = await open(p);
    await expectIds(actor, [request.id]);
  });
  it('AC-9: global Owner sees P and Q', async () => {
    const first = await open(p); const second = await open(q);
    await expectIds(owner, [first.id, second.id]);
  });
  it('AC-10: mine ignores decide permissions', async () => {
    await open(p); await open(q);
    await expectIds(approver, [], { mine: true });
  });
  it('AC-11: status is ANDed with visibility', async () => {
    const rejected = await open(p); const hidden = await open(q); await open(p);
    await db.approvalRequest.updateMany({ where: { id: { in: [rejected.id, hidden.id] } }, data: { status: 'rejected' } });
    await expectIds(approver, [rejected.id], { status: 'rejected' });
  });
  it('AC-12: newest first with id descending ties and database pagination', async () => {
    const older = await open(p); const newer = await open(p); const tied = await open(p); await open(q);
    await db.approvalRequest.update({ where: { id: older.id }, data: { createdAt: new Date('2026-01-01') } });
    await db.approvalRequest.updateMany({ where: { id: { in: [newer.id, tied.id] } }, data: { createdAt: new Date('2026-01-02') } });
    const expected = [newer.id, tied.id].sort().reverse().concat(older.id);
    expect(await ids(approver)).toEqual(expected);
    expect(await queries.list(approver, {}, { current: 2, size: 1 })).toMatchObject({ total: 3, current: 2, size: 1, hasNext: true, hasPrev: true, records: [{ id: expected[1] }] });
  });
  it('AC-13: detail decisions are ordered by decidedAt ascending', async () => {
    const request = await open(p);
    const second = await db.approvalDecision.create({ data: { requestId: request.id, deciderType: 'USER', deciderId: approver.id, decision: 'approve', decidedAt: new Date('2026-01-02') } });
    const first = await db.approvalDecision.create({ data: { requestId: request.id, deciderType: 'USER', deciderId: global.id, decision: 'approve', decidedAt: new Date('2026-01-01') } });
    const detail = await queries.get(approver, request.id);
    expect(detail.request.id).toBe(request.id);
    expect(detail.decisions.map((row) => row.id)).toEqual([first.id, second.id]);
  });
  it('AC-14: hidden and missing requests both look missing', async () => {
    const request = await open(q);
    await expect(queries.get(approver, request.id)).rejects.toEqual(new ApprovalRequestNotFoundError(request.id));
    await expect(queries.get(outsider, 'missing')).rejects.toEqual(new ApprovalRequestNotFoundError('missing'));
  });
  it('AC-15: system findById is unscoped and null for missing', async () => {
    const request = await open(q);
    expect(await queries.findById(request.id)).toEqual(request);
    expect(await queries.findById('missing')).toBeNull();
  });
  it('on-behalf-of visibility requires matching both principal type and id', async () => {
    const request = await open(q);
    await db.approvalRequest.update({ where: { id: request.id }, data: { onBehalfOfType: outsider.type, onBehalfOfId: outsider.id } });
    await expectIds(outsider, [request.id], { mine: true });
    expect((await queries.get(outsider, request.id)).request.id).toBe(request.id);
    await expectIds({ type: 'AGENT', id: outsider.id }, []);
  });
  it('global narrowed patterns apply across projects and agree with detail visibility', async () => {
    await grantKeys(db, outsider, ['approval.decide@label.*', 'approval.decide@role.manage'], null);
    await app.get(PermissionCache, { strict: false }).invalidate();
    const first = await open(p); const second = await open(q);
    const globalRequest = await insert('role.manage', null);
    const hidden = await insert('ticket.delete', p);
    await expectIds(outsider, [first.id, second.id, globalRequest.id]);
    for (const request of [first, second, globalRequest]) {
      expect((await queries.get(outsider, request.id)).request.id).toBe(request.id);
    }
    await expect(queries.get(outsider, hidden.id)).rejects.toEqual(new ApprovalRequestNotFoundError(hidden.id));
    expect((await queries.get(actor, first.id)).request.id).toBe(first.id);
    expect((await queries.get(global, first.id)).request.id).toBe(first.id);
    expect((await queries.get(owner, first.id)).request.id).toBe(first.id);
    expect((await queries.get(narrowed, first.id)).request.id).toBe(first.id);
    await expect(queries.get(narrowed, second.id)).rejects.toEqual(new ApprovalRequestNotFoundError(second.id));
    await expectIds(owner, [], { mine: true });
  });
  it('exact project patterns do not match longer keys or another project', async () => {
    await grantKeys(db, outsider, ['approval.decide@label.delete'], p);
    await app.get(PermissionCache, { strict: false }).invalidate();
    const request = await open(p); await open(q); await insert('label.delete.own', p);
    await expectIds(outsider, [request.id]);
    expect((await queries.get(outsider, request.id)).request.id).toBe(request.id);
  });
  it('project and exact permission filters cannot widen visibility', async () => {
    await open(p); await open(q); const ticket = await insert('ticket.delete', p);
    await expectIds(approver, [ticket.id], { projectId: p, permissionKey: 'ticket.delete' });
    await expectIds(approver, [], { projectId: q });
  });
});
