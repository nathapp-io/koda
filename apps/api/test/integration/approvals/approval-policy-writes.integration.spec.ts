import type { NathApplication } from '@nathapp/nestjs-app';
import { ApprovalPolicyService } from '../../../src/approvals/approval-policy.service';
import type { ApprovalPolicyInput } from '../../../src/approvals/domain/approval.domain';
import { ApprovalPolicyConflictError, ApprovalPolicyNotFoundError, ApprovalPolicySelfApplicationError, InvalidApprovalPolicyError } from '../../../src/approvals/domain/approval.errors';
import { AuditRecorder } from '../../../src/audit/audit-recorder.service';
import { grantRole } from '../../../src/permissions/test-helpers/permission-fixtures';
import { fixtureDb, withTestActor } from '../../helpers/action-context';
import { bootHttpApp } from '../../helpers/http-app';
import { resetDb } from '../../helpers/reset-db';
import { canRunDbTests } from '../../helpers/test-environment';

const base: ApprovalPolicyInput = { projectId: null, permissionPattern: 'ticket.delete', appliesTo: { kind: 'all' }, mode: 'human' };
const user = <T>(fn: () => Promise<T>) => withTestActor({ type: 'USER', id: 'u1' }, fn);
const agent = <T>(fn: () => Promise<T>) => withTestActor({ type: 'AGENT', id: 'a1' }, fn);

(canRunDbTests() ? describe : describe.skip)('approval policy writes through AppModule', () => {
  let app: NathApplication;
  let service: ApprovalPolicyService;
  let db: ReturnType<typeof fixtureDb>;
  beforeAll(async () => {
    await resetDb();
    app = await bootHttpApp({ registrationEnabled: false });
    db = fixtureDb(app);
    await db.project.create({ data: { id: 'p1', slug: 'policy-p1', key: 'POL1', name: 'Policy project' } });
    service = app.get(ApprovalPolicyService, { strict: false });
  });
  afterAll(async () => { await app?.close(); });
  beforeEach(async () => {
    await db.approvalPolicy.deleteMany();
    await db.auditEntry.deleteMany();
    await db.roleBinding.deleteMany({ where: { principalType: 'AGENT', principalId: 'a1' } });
  });
  afterEach(() => vi.restoreAllMocks());
  const create = (patch: Partial<ApprovalPolicyInput> = {}) => user(() => service.create({ ...base, ...patch }));
  const audits = () => db.auditEntry.findMany({ where: { key: 'approval.policy.manage' }, orderBy: { createdAt: 'asc' } });
  it('AC-1: creates the selector and writer with defaults', async () => {
    expect(await create()).toMatchObject({ selector: '*|ticket.delete|all', updatedByType: 'USER', updatedById: 'u1', timeoutSec: null, onTimeout: 'reject', requiredApprovals: 1, approverMustHoldAction: true, requireDistinctApprover: false });
  });
  it('AC-2: records the create audit', async () => {
    const row = await create();
    expect(await audits()).toEqual([expect.objectContaining({ key: 'approval.policy.manage', resourceType: 'approval-policy', resourceId: row.id, projectId: null, summary: 'created ticket.delete human' })]);
  });
  it('AC-3: rejects a duplicate without writing', async () => {
    await create();
    await expect(create()).rejects.toBeInstanceOf(ApprovalPolicyConflictError);
    expect(await db.approvalPolicy.count()).toBe(1);
    expect(await audits()).toHaveLength(1);
  });
  it('AC-4: rejects a below-floor policy without writing', async () => {
    await expect(create({ permissionPattern: 'role.manage', mode: 'none' })).rejects.toEqual(new InvalidApprovalPolicyError('below-floor'));
    expect(await db.approvalPolicy.count()).toBe(0);
    expect(await audits()).toHaveLength(0);
  });
  it('AC-5: updates values and audits changed fields only', async () => {
    const row = await create();
    expect(await user(() => service.update(row.id, { mode: 'self', timeoutSec: 600, requiredApprovals: 1 }))).toMatchObject({ mode: 'self', timeoutSec: 600 });
    expect(await audits()).toContainEqual(expect.objectContaining({ resourceId: row.id, summary: 'updated mode,timeoutSec' }));
  });
  it('AC-6: validates the merged row and preserves it on failure', async () => {
    const row = await create({ permissionPattern: 'role.*' });
    await expect(user(() => service.update(row.id, { onTimeout: 'approve' }))).rejects.toEqual(new InvalidApprovalPolicyError('timeout-approve'));
    expect(await db.approvalPolicy.findUnique({ where: { id: row.id } })).toEqual(row);
    expect(await audits()).toHaveLength(1);
  });
  it('AC-7: removes and audits', async () => {
    const row = await create();
    await user(() => service.remove(row.id));
    expect(await db.approvalPolicy.count()).toBe(0);
    expect(await audits()).toContainEqual(expect.objectContaining({ resourceId: row.id, summary: 'deleted ticket.delete' }));
  });
  it('AC-8: rejects unknown ids', async () => {
    await expect(user(() => service.update('missing', { mode: 'none' }))).rejects.toBeInstanceOf(ApprovalPolicyNotFoundError);
    await expect(user(() => service.remove('missing'))).rejects.toBeInstanceOf(ApprovalPolicyNotFoundError);
    expect(await audits()).toHaveLength(0);
  });
  it.each([
    ['AC-9', { kind: 'principal', principalType: 'AGENT', principalId: 'a1' }],
    ['AC-10', { kind: 'all' }],
  ] as const)('%s: refuses an agent self-applying create', async (_ac, appliesTo) => {
    await expect(agent(() => service.create({ ...base, appliesTo }))).rejects.toBeInstanceOf(ApprovalPolicySelfApplicationError);
    expect(await db.approvalPolicy.count()).toBe(0);
    expect(await audits()).toHaveLength(0);
  });
  it.each([['AC-11', 'p1'], ['AC-12', null]] as const)('%s: checks project bindings for role policies', async (_ac, projectId) => {
    await grantRole(db, { type: 'AGENT', id: 'a1' }, 'developer', 'p1');
    const role = await db.role.findUniqueOrThrow({ where: { key: 'developer' } });
    await expect(agent(() => service.create({ ...base, projectId, appliesTo: { kind: 'role', roleId: role.id } }))).rejects.toBeInstanceOf(ApprovalPolicySelfApplicationError);
    expect(await db.approvalPolicy.count()).toBe(0);
    expect(await audits()).toHaveLength(0);
  });
  it('AC-13: allows an agent to create a USER policy', async () => {
    expect(await agent(() => service.create({ ...base, appliesTo: { kind: 'type', principalType: 'USER' } }))).toMatchObject({ principalType: 'USER', updatedByType: 'AGENT', updatedById: 'a1' });
  });
  it('AC-14: refuses self-applying removal and update', async () => {
    const row = await create({ appliesTo: { kind: 'type', principalType: 'AGENT' } });
    await expect(agent(() => service.remove(row.id))).rejects.toBeInstanceOf(ApprovalPolicySelfApplicationError);
    await expect(agent(() => service.update(row.id, { mode: 'none' }))).rejects.toBeInstanceOf(ApprovalPolicySelfApplicationError);
    expect(await db.approvalPolicy.findUnique({ where: { id: row.id } })).toEqual(row);
    expect(await audits()).toHaveLength(1);
  });
  it('AC-15: filters project rows, not global or other projects', async () => {
    const p1 = await create({ projectId: 'p1' });
    await create({ projectId: 'p2' }); await create();
    expect(await service.list({ projectId: 'p1' }, { current: 1, size: 20 })).toEqual([p1]);
    expect(await service.list({ projectId: null }, { current: 1, size: 20 })).toHaveLength(1);
    expect(await service.list({}, { current: 2, size: 2 })).toHaveLength(1);
  });
  it('keeps identity immutable for untyped patches and ignores undefined fields', async () => {
    const row = await create();
    const patch = { projectId: 'p2', permissionPattern: 'role.manage', appliesTo: { kind: 'type', principalType: 'USER' }, mode: undefined, timeoutSec: 600 };
    const updated = await user(() => service.update(row.id, patch));
    expect(updated).toMatchObject({ selector: row.selector, projectId: null, permissionPattern: 'ticket.delete', principalType: null, mode: 'human', timeoutSec: 600 });
    expect(await audits()).toContainEqual(expect.objectContaining({ summary: 'updated timeoutSec' }));
  });
  it('validates before anti-escalation and checks anti-escalation before conflicts', async () => {
    await expect(agent(() => service.create({ ...base, permissionPattern: 'role.manage', mode: 'none' }))).rejects.toEqual(new InvalidApprovalPolicyError('below-floor'));
    await create();
    await expect(agent(() => service.create(base))).rejects.toBeInstanceOf(ApprovalPolicySelfApplicationError);
    expect(await db.approvalPolicy.count()).toBe(1);
    expect(await audits()).toHaveLength(1);
  });
  it('allows nonmatching subjects, missing role ids and project-only roles in another project', async () => {
    await grantRole(db, { type: 'AGENT', id: 'a1' }, 'developer', 'p1');
    const role = await db.role.findUniqueOrThrow({ where: { key: 'developer' } });
    const subjects: ApprovalPolicyInput['appliesTo'][] = [
      { kind: 'role', roleId: role.id }, { kind: 'role', roleId: 'missing' },
      { kind: 'principal', principalType: 'AGENT', principalId: 'other' },
      { kind: 'principal', principalType: 'USER', principalId: 'a1' },
      { kind: 'type', principalType: 'ASSISTANT' },
    ];
    for (const appliesTo of subjects) {
      const row = await agent(() => service.create({ ...base, projectId: 'p2', appliesTo, approverMustHoldAction: false, requireDistinctApprover: true }));
      expect(row).toMatchObject({ projectId: 'p2', approverMustHoldAction: false, requireDistinctApprover: true });
      expect(await agent(() => service.update(row.id, { mode: 'self' }))).toMatchObject({ mode: 'self' });
      await agent(() => service.remove(row.id));
    }
    expect(await db.approvalPolicy.count()).toBe(0);
  });
  it('refuses updating or deleting global role policies for a project-only role holder', async () => {
    await grantRole(db, { type: 'AGENT', id: 'a1' }, 'developer', 'p1');
    const role = await db.role.findUniqueOrThrow({ where: { key: 'developer' } });
    const row = await create({ appliesTo: { kind: 'role', roleId: role.id } });
    await expect(agent(() => service.update(row.id, { mode: 'none' }))).rejects.toBeInstanceOf(ApprovalPolicySelfApplicationError);
    await expect(agent(() => service.remove(row.id))).rejects.toBeInstanceOf(ApprovalPolicySelfApplicationError);
    expect(await db.approvalPolicy.findUnique({ where: { id: row.id } })).toEqual(row);
  });
  it('supports no-op patches and pattern-filtered lists', async () => {
    const row = await create();
    expect(await user(() => service.update(row.id, {}))).toMatchObject({ id: row.id, mode: 'human' });
    expect(await audits()).toContainEqual(expect.objectContaining({ summary: 'updated ' }));
    expect(await service.list({ permissionPattern: 'role.*' }, { current: 1, size: 20 })).toEqual([]);
  });
  it.each(['create', 'update', 'remove'] as const)('rolls back %s when audit fails', async (operation) => {
    const row = operation === 'create' ? null : await create();
    vi.spyOn(app.get(AuditRecorder), 'record').mockRejectedValue(new Error('audit unavailable'));
    await expect(user(async () => {
      if (operation === 'create') return service.create(base);
      if (!row) throw new Error('missing fixture');
      if (operation === 'update') return service.update(row.id, { mode: 'self' });
      return service.remove(row.id);
    })).rejects.toThrow('audit unavailable');
    expect(await db.approvalPolicy.findMany()).toEqual(row ? [row] : []);
  });
});
