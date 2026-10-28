import { ApprovalPending } from '../../approvals/route/approval-pending';
import type { ApprovalRouteGate } from '../../approvals/route/approval-route-gate';
import { APPROVAL_GATED_METADATA } from '../../approvals/route/approval-gated.decorator';
import type { BudgetsService } from './budgets.service';
import { FleetBudgetsController } from './fleet-budgets.controller';
import { ProjectFleetBudgetsController } from './project-fleet-budgets.controller';

const ctx = { project: { id: 'resolved-p1', slug: 'web' } };
const policy = { scopeType: 'global' as const, windowKind: 'lifetime' as const, amountUsd: 10 };
for (const project of [false, true]) {
  for (const action of ['create', 'update', 'remove', 'resume'] as const) {
    const keyAction = action === 'remove' ? 'delete' : action;
    describe(`${project ? 'project' : 'global'} budget ${action} handler`, () => {
      function build(outcome: object) {
        const gate = { run: vi.fn().mockResolvedValue(outcome) };
        const budgets = { create: vi.fn(), update: vi.fn(), remove: vi.fn(), resume: vi.fn() };
        const global = new FleetBudgetsController(budgets as unknown as BudgetsService, gate as unknown as ApprovalRouteGate);
        const scoped = new ProjectFleetBudgetsController(budgets as unknown as BudgetsService, gate as unknown as ApprovalRouteGate);
        const invoke = () => {
          switch (action) {
            case 'create': return project ? scoped.create(policy, ctx) : global.create(policy);
            case 'update': return project ? scoped.update('b1', { amountUsd: 42 }, ctx) : global.update('b1', { amountUsd: 42 });
            case 'remove': return project ? scoped.remove('b1', ctx) : global.remove('b1');
            case 'resume': return project ? scoped.resume('b1', {}, ctx) : global.resume('b1', {});
          }
        };
        return { gate, budgets, invoke, handler: project ? scoped[action] : global[action] };
      }
      it('gates the exact frozen input and maps executed without directly writing', async () => {
        const result = { id: 'b1' };
        const { gate, budgets, invoke, handler } = build({ status: 'executed', result });
        const answer = await invoke();
        const input = action === 'create' ? (project ? { projectId: ctx.project.id, policy } : policy)
          : { ...(project ? { projectId: ctx.project.id } : {}), id: 'b1', ...(action === 'update' ? { patch: { amountUsd: 42 } } : action === 'resume' ? { body: {} } : {}) };
        expect(gate.run).toHaveBeenCalledExactlyOnceWith({ key: `fleet.budget.${keyAction}`, variant: `rest:${project ? 'project-' : ''}fleet-budgets.${keyAction}`, projectId: project ? ctx.project.id : null, input });
        if (action === 'remove') expect(answer).toBeUndefined();
        else expect(answer).toMatchObject({ data: result });
        expect(Reflect.getMetadata(APPROVAL_GATED_METADATA, handler)).toBeDefined();
        for (const method of Object.values(budgets)) expect(method).not.toHaveBeenCalled();
      });
      it('throws ApprovalPending with the gate request, including on a 204 route', async () => {
        const request = { id: 'request-1' };
        const { invoke } = build({ status: 'pending', request });
        await expect(invoke()).rejects.toBeInstanceOf(ApprovalPending);
        await expect(invoke()).rejects.toMatchObject({ request });
      });
    });
  }
}
