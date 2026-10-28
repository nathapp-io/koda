import { ValidationAppException } from '@nathapp/nestjs-common';
import { ApprovalCommandRegistry, type ApprovalCommand } from '../../approvals/approval-command.registry';
import type { ActorPrincipalLoader } from '../../auth/principal/actor-principal.loader';
import type { AgentPrincipal } from '../../auth/principal/koda-principal.types';
import { BUDGET_ROUTE_VARIANTS, BudgetRouteCommands } from './budget-route.commands';
import type { BudgetsService } from './budgets.service';

const principal: AgentPrincipal = {
  actorType: 'agent', id: 'a1', name: 'agent', slug: 'agent', status: 'ACTIVE',
  capabilities: [], blacklisted: false, revoked: false, authorities: [], extra: { slug: 'agent' },
};
const policy = { scopeType: 'global', windowKind: 'lifetime', amountUsd: 10 };
const actions = ['create', 'update', 'delete', 'resume'] as const;
function requiredCommand(registry: ApprovalCommandRegistry, key: string, variant: string): ApprovalCommand {
  const command = registry.get(key, variant);
  if (!command) throw new Error(`Missing command: ${key}#${variant}`);
  return command;
}

describe('BudgetRouteCommands', () => {
  function build() {
    const registry = new ApprovalCommandRegistry();
    const result = { id: 'b1', scopeType: 'global' };
    const budgets = { create: vi.fn().mockResolvedValue(result), update: vi.fn().mockResolvedValue(result), remove: vi.fn().mockResolvedValue(undefined), resume: vi.fn().mockResolvedValue(result) };
    const loader = { forContext: vi.fn().mockResolvedValue(principal) };
    new BudgetRouteCommands(registry, budgets as unknown as BudgetsService, loader as unknown as ActorPrincipalLoader).onModuleInit();
    return { registry, budgets, loader, result };
  }

  it('AC-12: registers all eight variants under their matching keys', () => {
    const { registry } = build();
    expect(Object.values(BUDGET_ROUTE_VARIANTS)).toHaveLength(8);
    for (const scope of ['global', 'project'] as const) {
      for (const action of actions) {
        const variant = BUDGET_ROUTE_VARIANTS[`${scope}${action[0].toUpperCase()}${action.slice(1)}` as keyof typeof BUDGET_ROUTE_VARIANTS];
        expect(registry.get(`fleet.budget.${action}`, variant)).toMatchObject({ key: `fleet.budget.${action}`, variant });
      }
    }
  });

  for (const scope of ['global', 'project'] as const) {
    for (const action of actions) {
      const variant = `rest:${scope === 'global' ? '' : 'project-'}fleet-budgets.${action}`;
      it(`${variant}: parses, reloads principal, calls service and projects result (AC-13)`, async () => {
        const { registry, budgets, loader, result } = build();
        const command = requiredCommand(registry, `fleet.budget.${action}`, variant);
        const ids = { ...(scope === 'project' ? { projectId: 'p1' } : {}), id: 'b1' };
        const input = action === 'create' ? (scope === 'global' ? policy : { projectId: 'p1', policy })
          : action === 'update' ? { ...ids, patch: { amountUsd: 42, extra: true } }
          : action === 'resume' ? { ...ids, body: { amountUsd: 42, extra: true } } : { ...ids, extra: true };
        const parsed = command.parse(input);
        expect(command.parse(parsed)).toEqual(parsed);
        const output = await command.execute(parsed);
        expect(loader.forContext).toHaveBeenCalledTimes(1);
        const route = scope === 'global' ? { kind: 'admin' } : { kind: 'project', projectId: 'p1' };
        const method = action === 'delete' ? 'remove' : action;
        const args = action === 'create' ? [policy] : action === 'delete' ? ['b1'] : ['b1', action === 'update' ? { amountUsd: 42 } : 42];
        expect(budgets[method]).toHaveBeenCalledExactlyOnceWith(principal.id, route, ...args);
        if (action === 'delete') {
          expect(parsed).toEqual(ids);
          expect(output).toBeNull();
          expect(command.toResult).toBeUndefined();
        } else {
          expect(output).toBe(result);
          expect(command.toResult?.(output)).toBe(result);
        }
      });
      if (action !== 'create' || scope === 'project') {
        it(`${variant}: refuses malformed ids before service execution`, () => {
          const { registry, budgets } = build();
          const command = requiredCommand(registry, `fleet.budget.${action}`, variant);
          for (const raw of [null, [], {}, { id: '' }, { id: 7 }, { projectId: 'p1' }]) {
            expect(() => command.parse(raw)).toThrow(ValidationAppException);
          }
          expect(budgets.remove).not.toHaveBeenCalled();
        });
      }
      if (action === 'update' || action === 'resume') {
        it(`${variant}: missing body is parsed as an empty DTO`, () => {
          const { registry } = build();
          const command = requiredCommand(registry, `fleet.budget.${action}`, variant);
          const ids = { ...(scope === 'project' ? { projectId: 'p1' } : {}), id: 'b1' };
          expect(command.parse(ids)).toEqual({ ...ids, [action === 'update' ? 'patch' : 'body']: {} });
          for (const invalidBody of [null, [], 'bad']) {
            expect(() => command.parse({ ...ids, [action === 'update' ? 'patch' : 'body']: invalidBody })).toThrow(ValidationAppException);
          }
          expect(() => command.parse({ ...ids, [action === 'update' ? 'patch' : 'body']: { amountUsd: -1 } })).toThrow(ValidationAppException);
        });
      }
    }
  }
});
