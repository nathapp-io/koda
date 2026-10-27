import type { ApprovalPolicyRecord } from './domain/approval.domain';
import type { ApprovalPolicyResolver } from './approval-policy.resolver';

const subject = { type: 'AGENT' as const, id: 'a1' };
const assistant = { type: 'ASSISTANT' as const, id: 'assistant' };
function policy(id: string, patch: Partial<ApprovalPolicyRecord> = {}): ApprovalPolicyRecord {
  return {
    id, selector: id, projectId: null, permissionPattern: 'ticket.delete',
    principalType: null, principalId: null, roleId: null, mode: 'none',
    timeoutSec: null, onTimeout: 'reject', requiredApprovals: 1,
    approverMustHoldAction: true, requireDistinctApprover: false,
    updatedByType: 'USER', updatedById: 'admin', createdAt: new Date(0), updatedAt: new Date(0),
    ...patch,
  };
}

describe('ApprovalPolicyResolver', () => {
  let resolver: ApprovalPolicyResolver;
  let findCandidates: ReturnType<typeof vi.fn>;
  let roleIdsAt: ReturnType<typeof vi.fn>;
  beforeEach(async () => {
    findCandidates = vi.fn().mockResolvedValue([]);
    roleIdsAt = vi.fn().mockResolvedValue(['r1']);
    const { ApprovalPolicyResolver } = await import('./approval-policy.resolver');
    resolver = new ApprovalPolicyResolver({ findCandidates }, { roleIdsAt });
  });
  const input = { key: 'ticket.delete', projectId: null, subject };

  it('AC-1: falls back to catalog defaults', async () => {
    expect(await resolver.resolve(input)).toEqual({ mode: 'agent', floor: 'none', policy: null, source: 'default' });
    expect(findCandidates).toHaveBeenCalledExactlyOnceWith('ticket.delete', null);
  });
  it('AC-2: skips policy reads for non-approvable keys', async () => {
    expect(await resolver.resolve({ ...input, key: 'ticket.read' })).toEqual({ mode: 'none', floor: 'none', policy: null, source: 'not-approvable' });
    expect(findCandidates).not.toHaveBeenCalled();
    expect(roleIdsAt).not.toHaveBeenCalled();
  });
  it('AC-3: rejects unknown keys', async () => {
    await expect(resolver.resolve({ ...input, key: 'no.such.key' })).rejects.toThrow('unknown permission key: no.such.key');
    expect(findCandidates).not.toHaveBeenCalled();
  });
  it('AC-4: project all precedes global principal', async () => {
    const chosen = policy('project', { projectId: 'p1', mode: 'human' });
    findCandidates.mockResolvedValue([policy('global', { principalType: 'AGENT', principalId: 'a1' }), chosen]);
    expect(await resolver.resolve({ ...input, projectId: 'p1' })).toMatchObject({ mode: 'human', policy: chosen, source: 'policy' });
  });
  it('AC-5: project principal precedes role, type and all', async () => {
    const chosen = policy('principal', { projectId: 'p1', principalType: 'AGENT', principalId: 'a1', mode: 'self' });
    findCandidates.mockResolvedValue([
      policy('all', { projectId: 'p1', mode: 'human' }),
      policy('type', { projectId: 'p1', principalType: 'AGENT', mode: 'human' }),
      policy('role', { projectId: 'p1', roleId: 'r1', mode: 'human' }), chosen,
    ]);
    expect(await resolver.resolve({ ...input, projectId: 'p1' })).toMatchObject({ mode: 'self', policy: chosen });
  });
  it('AC-6: project role precedes type', async () => {
    const chosen = policy('role', { projectId: 'p1', roleId: 'r1' });
    findCandidates.mockResolvedValue([policy('type', { projectId: 'p1', principalType: 'AGENT', mode: 'human' }), chosen]);
    expect(await resolver.resolve({ ...input, projectId: 'p1' })).toMatchObject({ mode: 'none', policy: chosen });
  });
  it('AC-7: ignores roles the subject does not hold', async () => {
    const chosen = policy('type', { projectId: 'p1', principalType: 'AGENT', mode: 'human' });
    findCandidates.mockResolvedValue([policy('role', { projectId: 'p1', roleId: 'r2' }), chosen]);
    expect(await resolver.resolve({ ...input, projectId: 'p1' })).toMatchObject({ mode: 'human', policy: chosen });
  });
  it('AC-8: exact pattern precedes wildcard', async () => {
    const chosen = policy('exact', { mode: 'human' });
    findCandidates.mockResolvedValue([policy('wildcard', { permissionPattern: 'ticket.*' }), chosen]);
    expect(await resolver.resolve(input)).toMatchObject({ mode: 'human', policy: chosen });
  });
  it('AC-9: longer wildcard precedes shorter', async () => {
    const chosen = policy('long', { permissionPattern: 'ticket.label.*' });
    findCandidates.mockResolvedValue([policy('short', { permissionPattern: 'ticket.*', mode: 'human' }), chosen]);
    expect(await resolver.resolve({ ...input, key: 'ticket.label.remove' })).toMatchObject({ mode: 'none', policy: chosen });
  });
  it('AC-10: strictest role mode wins ties', async () => {
    roleIdsAt.mockResolvedValue(['r1', 'r2']);
    const chosen = policy('r2', { projectId: 'p1', roleId: 'r2', mode: 'human' });
    findCandidates.mockResolvedValue([policy('r1', { projectId: 'p1', roleId: 'r1', mode: 'self' }), chosen]);
    expect(await resolver.resolve({ ...input, projectId: 'p1' })).toMatchObject({ mode: 'human', policy: chosen });
  });
  it('AC-11: clamps policy mode to catalog floor', async () => {
    const chosen = policy('low', { permissionPattern: 'role.manage' });
    findCandidates.mockResolvedValue([chosen]);
    expect(await resolver.resolve({ ...input, key: 'role.manage' })).toEqual({ mode: 'human', floor: 'human', policy: chosen, source: 'policy' });
  });
  it('AC-12: assistant ignores all-subject overrides and defaults to human', async () => {
    findCandidates.mockResolvedValue([policy('all')]);
    expect(await resolver.resolve({ ...input, subject: assistant })).toEqual({ mode: 'human', floor: 'none', policy: null, source: 'default' });
    expect(roleIdsAt).not.toHaveBeenCalled();
  });
  it('AC-13: assistant matches explicit type override', async () => {
    const chosen = policy('assistant', { principalType: 'ASSISTANT' });
    findCandidates.mockResolvedValue([chosen]);
    expect(await resolver.resolve({ ...input, subject: assistant })).toMatchObject({ mode: 'none', policy: chosen, source: 'policy' });
  });
  it('AC-15: role lookups use the requested project or global scope', async () => {
    await resolver.resolve({ ...input, projectId: 'p1' });
    await resolver.resolve(input);
    expect(roleIdsAt.mock.calls).toEqual([[subject, { projectId: 'p1' }], [subject, 'global']]);
  });
  it('breaks equal-mode role ties by smallest id, regardless of repository order', async () => {
    roleIdsAt.mockResolvedValue(['r1', 'r2']);
    const chosen = policy('a', { roleId: 'r2', mode: 'self' });
    findCandidates.mockResolvedValue([policy('z', { roleId: 'r1', mode: 'self' }), chosen]);
    expect((await resolver.resolve(input)).policy).toEqual(chosen);
  });
  it('does not match another principal id or type', async () => {
    findCandidates.mockResolvedValue([
      policy('other-id', { principalType: 'AGENT', principalId: 'a2' }),
      policy('other-type', { principalType: 'USER', principalId: 'a1' }),
      policy('user-type', { principalType: 'USER' }),
    ]);
    expect((await resolver.resolve(input)).source).toBe('default');
  });
  it('matches USER all-subject and principal policies', async () => {
    const chosen = policy('user', { principalType: 'USER', principalId: 'u1', mode: 'self' });
    findCandidates.mockResolvedValue([policy('all', { mode: 'human' }), chosen]);
    expect((await resolver.resolve({ ...input, subject: { type: 'USER', id: 'u1' } })).policy).toEqual(chosen);
    findCandidates.mockResolvedValue([policy('all', { mode: 'human' })]);
    expect((await resolver.resolve({ ...input, subject: { type: 'USER', id: 'u1' } })).mode).toBe('human');
  });
  it('AC-1: SYSTEM matches a project pattern-only policy', async () => {
    const chosen = policy('pattern', { projectId: 'p1', permissionPattern: 'fleet.budget.override', mode: 'human' });
    findCandidates.mockResolvedValue([chosen]);
    expect(await resolver.resolve({ key: 'fleet.budget.override', projectId: 'p1', subject: { type: 'SYSTEM', id: 'budget' } }))
      .toMatchObject({ mode: 'human', policy: chosen, source: 'policy' });
  });
  it('AC-2: SYSTEM ignores role policies and uses the catalog default', async () => {
    findCandidates.mockResolvedValue([policy('role', { projectId: 'p1', permissionPattern: 'fleet.budget.override', roleId: 'r1', mode: 'human' })]);
    expect(await resolver.resolve({ key: 'fleet.budget.override', projectId: 'p1', subject: { type: 'SYSTEM', id: 'budget' } }))
      .toEqual({ mode: 'agent', floor: 'self', policy: null, source: 'default' });
  });
  it('AC-3: SYSTEM ignores type policies and uses the catalog default', async () => {
    findCandidates.mockResolvedValue([policy('type', { projectId: 'p1', permissionPattern: 'fleet.budget.override', principalType: 'AGENT', mode: 'human' })]);
    expect(await resolver.resolve({ key: 'fleet.budget.override', projectId: 'p1', subject: { type: 'SYSTEM', id: 'budget' } }))
      .toEqual({ mode: 'agent', floor: 'self', policy: null, source: 'default' });
  });
  it('AC-4: SYSTEM ignores principal policies and uses the catalog default', async () => {
    findCandidates.mockResolvedValue([policy('principal', { projectId: 'p1', permissionPattern: 'fleet.budget.override', principalType: 'AGENT', principalId: 'budget', mode: 'human' })]);
    expect(await resolver.resolve({ key: 'fleet.budget.override', projectId: 'p1', subject: { type: 'SYSTEM', id: 'budget' } }))
      .toEqual({ mode: 'agent', floor: 'self', policy: null, source: 'default' });
  });
  it('AC-5: SYSTEM without a policy uses the catalog default', async () => {
    expect(await resolver.resolve({ key: 'fleet.budget.override', projectId: 'p1', subject: { type: 'SYSTEM', id: 'budget' } }))
      .toEqual({ mode: 'agent', floor: 'self', policy: null, source: 'default' });
  });
  it('AC-6: does not look up roles for a SYSTEM subject', async () => {
    await resolver.resolve({ key: 'fleet.budget.override', projectId: 'p1', subject: { type: 'SYSTEM', id: 'budget' } });
    expect(roleIdsAt).not.toHaveBeenCalled();
  });
  it('propagates repository and membership read failures', async () => {
    findCandidates.mockRejectedValue(new Error('policies unavailable'));
    await expect(resolver.resolve(input)).rejects.toThrow('policies unavailable');
    findCandidates.mockResolvedValue([]);
    roleIdsAt.mockRejectedValue(new Error('bindings unavailable'));
    await expect(resolver.resolve(input)).rejects.toThrow('bindings unavailable');
  });
});
