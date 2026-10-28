import { ApprovalCommandRegistry } from '../../approvals/approval-command.registry';
import { ApprovalExecutionService } from '../../approvals/approval-execution.service';
import { approvalInputHash } from '../../approvals/approval-input';
import type { ApprovalRequestRecord } from '../../approvals/domain/approval.domain';
import type { AgentPrincipal } from '../../auth/principal/koda-principal.types';
import { AfterCommitService } from '../../permissions/after-commit.service';
import { BudgetRouteCommands } from './budget-route.commands';
import { BudgetsService } from './budgets.service';
import type { BudgetPolicyRecord } from './domain/budget.domain';

const now = new Date('2026-11-05T09:00:00Z');
const principal: AgentPrincipal = {
  actorType: 'agent', id: 'a1', name: 'agent', slug: 'agent', status: 'ACTIVE',
  capabilities: [], blacklisted: false, revoked: false, authorities: [], extra: { slug: 'agent' },
};
type Action = 'create' | 'update' | 'delete' | 'resume';
type Outcome = 'commit' | 'settlement-failure' | 'commit-failure';

/** Real commands, budget service and execution owner; only persistence and external effects are injected. */
function build(action: Action, outcome: Outcome) {
  const policy: BudgetPolicyRecord = {
    id: 'b1', scopeType: 'project', scopeId: 'p1', scopeKey: 'project:p1', projectId: 'p1',
    windowKind: 'lifetime', amountUsd: '10', warnPercent: null, hardStop: true, runningJobs: 'finish',
    pausedAt: now, pausedWindowStart: new Date(0), createdById: 'a1', updatedById: 'a1', createdAt: now, updatedAt: now,
  };
  const input = action === 'create' ? { projectId: 'p1', policy: { scopeType: 'project', windowKind: 'lifetime', amountUsd: 10 } }
    : { projectId: 'p1', id: 'b1', ...(action === 'update' ? { patch: { amountUsd: 42 } } : action === 'resume' ? { body: {} } : {}) };
  const request: ApprovalRequestRecord = {
    id: 'r1', permissionKey: `fleet.budget.${action}`, variant: `rest:project-fleet-budgets.${action}`, projectId: 'p1',
    actor: { type: 'AGENT', id: 'a1' }, onBehalfOf: null, origin: 'rest', correlationId: 'corr-1',
    input, inputHash: approvalInputHash(input), requiredMode: 'agent', policyId: null, onTimeout: 'reject',
    approverMustHoldAction: true, requireDistinctApprover: false, status: 'approved', satisfiedBy: 'human',
    approverType: 'USER', approverId: 'u1', expiresAt: new Date(now.getTime() + 1000),
    decidedAt: now, settledAt: null, result: null, createdAt: now,
  };
  let inTransaction = false;
  let committed = false;
  const observations: boolean[] = [];
  const evaluator = { signal: vi.fn(() => { observations.push(committed); }) };
  const publisher = { publish: vi.fn(() => { observations.push(committed); }) };
  const live = [{ id: 'event1', type: 'fleet_approval', projectId: 'p1', approvalId: 'f1', status: 'approved', at: now.toISOString() }];
  const repo = {
    create: vi.fn().mockResolvedValue(policy), lockById: vi.fn().mockResolvedValue(policy),
    update: vi.fn().mockResolvedValue({ ...policy, pausedAt: null }), delete: vi.fn().mockResolvedValue(undefined),
    windowSpend: vi.fn().mockResolvedValue('0'), insertIncident: vi.fn().mockResolvedValue(undefined),
  };
  const tx = {
    run: vi.fn(async (fn: () => Promise<unknown>) => {
      if (inTransaction) return fn(); // Domain run joins the approval owner's transaction.
      inTransaction = true;
      try {
        const result = await fn();
        if (outcome === 'commit-failure') throw new Error('commit failed');
        committed = true;
        return result;
      } finally { inTransaction = false; }
    }),
  };
  const budgets = new BudgetsService(
    repo as never, evaluator as never, { record: vi.fn() } as never, tx as never,
    { closeForPolicy: vi.fn().mockResolvedValue({ approval: null, live }) } as never,
    publisher as never, { record: vi.fn() } as never,
  );
  const registry = new ApprovalCommandRegistry();
  new BudgetRouteCommands(registry, budgets, { forContext: vi.fn().mockResolvedValue(principal) } as never).onModuleInit();
  const requests = {
    findById: vi.fn().mockResolvedValue(request), lockById: vi.fn().mockResolvedValue(request),
    transition: vi.fn(async (_id: string, _from: string, patch: Partial<ApprovalRequestRecord>) => {
      if (patch.status === 'executed' && outcome === 'settlement-failure') throw new Error('settlement failed');
      return { ...request, ...patch };
    }),
  };
  const execution = new ApprovalExecutionService(
    tx as never, requests as never,
    { effectiveKeys: vi.fn().mockResolvedValue(new Set([request.permissionKey])) } as never,
    registry, { record: vi.fn() } as never, new AfterCommitService(),
  );
  return { execution, evaluator, publisher, observations, repo, live, budgets };
}

describe('budget command committed effects', () => {
  for (const action of ['create', 'update', 'delete', 'resume'] as const) {
    for (const outcome of ['commit', 'settlement-failure', 'commit-failure'] as const) {
      it(`${action}: external effects follow owning approval transaction ${outcome}`, async () => {
        const s = build(action, outcome);
        if (outcome === 'commit-failure') {
          await expect(s.execution.execute('r1', now)).rejects.toThrow('commit failed');
        } else {
          expect(await s.execution.execute('r1', now)).toMatchObject({
            status: outcome === 'commit' ? 'executed' : 'failed',
          });
        }
        // Prove the actual budget write ran before the simulated settlement/commit failure.
        expect(s.repo[action === 'resume' ? 'update' : action]).toHaveBeenCalledTimes(1);
        if (outcome === 'commit') {
          expect(s.observations).toEqual([true]);
          if (action === 'create' || action === 'update') {
            expect(s.evaluator.signal).toHaveBeenCalledExactlyOnceWith(['project:p1']);
            expect(s.publisher.publish).not.toHaveBeenCalled();
          } else {
            expect(s.publisher.publish).toHaveBeenCalledExactlyOnceWith(s.live);
            expect(s.evaluator.signal).not.toHaveBeenCalled();
          }
        } else {
          expect(s.observations).toEqual([]);
          expect(s.evaluator.signal).not.toHaveBeenCalled();
          expect(s.publisher.publish).not.toHaveBeenCalled();
        }
      });
    }
    it(`${action}: standalone service calls still publish after their own transaction`, async () => {
      const s = build(action, 'commit');
      const route = { kind: 'project' as const, projectId: 'p1' };
      switch (action) {
        case 'create': await s.budgets.create('a1', route, { scopeType: 'project', windowKind: 'lifetime', amountUsd: 10 }); break;
        case 'update': await s.budgets.update('a1', route, 'b1', { amountUsd: 42 }); break;
        case 'delete': await s.budgets.remove('a1', route, 'b1'); break;
        case 'resume': await s.budgets.resume('a1', route, 'b1', undefined); break;
      }
      expect(s.observations).toEqual([true]);
    });
  }
});
