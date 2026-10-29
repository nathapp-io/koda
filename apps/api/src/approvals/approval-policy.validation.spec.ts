import type { ApprovalMode } from '../permissions/catalog';
import type { ApprovalPolicyInput } from './domain/approval.domain';
import { policySelector, validateApprovalPolicy } from './approval-policy.validation';

/** Project null, `ticket.delete`, subject `all`, mode `agent`, no timeout, reject, one approval. */
const BASE: ApprovalPolicyInput = {
  projectId: null,
  permissionPattern: 'ticket.delete',
  appliesTo: { kind: 'all' },
  mode: 'agent',
  timeoutSec: null,
  onTimeout: 'reject',
  requiredApprovals: 1,
};

describe('validateApprovalPolicy', () => {
  it('AC-1: accepts the base input', () => {
    expect(validateApprovalPolicy(BASE)).toBeNull();
  });

  it('AC-2: refuses a known but non-approvable key', () => {
    expect(validateApprovalPolicy({ ...BASE, permissionPattern: 'ticket.read' })).toBe('pattern');
  });

  it('US-001 AC-6: refuses a policy for non-approvable test-hook key', () => {
    expect(validateApprovalPolicy({ ...BASE, permissionPattern: 'testhook.schedule.fire' })).toBe('pattern');
  });

  it.each(['kb.search', 'context.query', 'retrieval.evaluate'])(
    'US-001 AC-10: refuses a policy for non-approvable read key %s',
    (key) => {
      expect(validateApprovalPolicy({ ...BASE, permissionPattern: key })).toBe('pattern');
    },
  );

  it('AC-3: refuses a prefix wildcard that matches no approvable key', () => {
    expect(validateApprovalPolicy({ ...BASE, permissionPattern: 'ti.*' })).toBe('pattern');
  });

  it('AC-4: refuses the bare wildcard', () => {
    expect(validateApprovalPolicy({ ...BASE, permissionPattern: '*' })).toBe('pattern');
  });

  it('AC-5: refuses a principal subject with an empty principalId', () => {
    expect(validateApprovalPolicy({
      ...BASE,
      appliesTo: { kind: 'principal', principalType: 'AGENT', principalId: '' },
    })).toBe('subject');
  });

  it('AC-6: refuses an unknown mode', () => {
    expect(validateApprovalPolicy({ ...BASE, mode: 'sometimes' as ApprovalMode })).toBe('mode');
  });

  it('AC-7: refuses a mode below the pattern floor', () => {
    expect(validateApprovalPolicy({ ...BASE, permissionPattern: 'role.manage', mode: 'agent' }))
      .toBe('below-floor');
  });

  it('AC-8: accepts the strictest mode over a wildcard floor', () => {
    expect(validateApprovalPolicy({ ...BASE, permissionPattern: 'role.*', mode: 'human' })).toBeNull();
  });

  it('AC-9: refuses a timeout under a minute', () => {
    expect(validateApprovalPolicy({ ...BASE, timeoutSec: 59 })).toBe('timeout');
  });

  it('AC-10: accepts the shortest timeout', () => {
    expect(validateApprovalPolicy({ ...BASE, timeoutSec: 60 })).toBeNull();
  });

  it('AC-11: refuses a timeout past thirty days', () => {
    expect(validateApprovalPolicy({ ...BASE, timeoutSec: 2_592_001 })).toBe('timeout');
  });

  it('AC-12: refuses approve-on-timeout above a none floor', () => {
    expect(validateApprovalPolicy({
      ...BASE, permissionPattern: 'role.manage', mode: 'human', onTimeout: 'approve',
    })).toBe('timeout-approve');
  });

  it('AC-13: accepts approve-on-timeout at a none floor', () => {
    expect(validateApprovalPolicy({ ...BASE, onTimeout: 'approve' })).toBeNull();
  });

  it('AC-14: refuses more than one required approval', () => {
    expect(validateApprovalPolicy({ ...BASE, requiredApprovals: 2 })).toBe('required-approvals');
  });
});

describe('policySelector', () => {
  it('AC-15: joins project, pattern and the principal subject', () => {
    expect(policySelector({
      projectId: 'p1',
      permissionPattern: 'ticket.*',
      appliesTo: { kind: 'principal', principalType: 'AGENT', principalId: 'a1' },
    })).toBe('p1|ticket.*|principal:AGENT:a1');
  });

  it('renders a global policy and every other subject kind', () => {
    const global = (appliesTo: ApprovalPolicyInput['appliesTo']): string =>
      policySelector({ projectId: null, permissionPattern: 'ticket.delete', appliesTo });

    expect(global({ kind: 'all' })).toBe('*|ticket.delete|all');
    expect(global({ kind: 'type', principalType: 'ASSISTANT' })).toBe('*|ticket.delete|type:ASSISTANT');
    expect(global({ kind: 'role', roleId: 'r1' })).toBe('*|ticket.delete|role:r1');
    expect(global({ kind: 'principal', principalType: 'USER', principalId: 'u1' }))
      .toBe('*|ticket.delete|principal:USER:u1');
  });
});
