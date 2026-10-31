import { JsonResponse } from '@nathapp/nestjs-common';
import { ApprovalPending } from '../../approvals/route/approval-pending';
import type { ApprovalRouteGate } from '../../approvals/route/approval-route-gate';
import { FleetReposController } from './fleet-repos.controller';
import { RunnersController } from '../runners/runners.controller';
import { FleetAnalyticsController } from '../analytics/fleet-analytics.controller';
import type { FleetReposService } from './fleet-repos.service';
import type { RunnersService } from '../runners/runners.service';
import type { AnalyticsService } from '../analytics/analytics.service';

// Construct through a typed factory so this test can run red against the old constructor.
function construct<T>(cls: Function, service: object, gate: object): T {
  return Reflect.construct(cls, [service, gate]) as T;
}
describe('fleet admin handler gates', () => {
  const cases = [
    { key: 'fleet.repo.create', variant: 'rest:fleet-repos.create', input: { projectSlug: 'web', provider: 'github' as const, owner: 'acme', name: 'app' }, noBody: false, call: (repos: FleetReposController) => repos.create({ projectSlug: 'web', provider: 'github', owner: 'acme', name: 'app' }) },
    { key: 'fleet.repo.delete', variant: 'rest:fleet-repos.delete', input: { id: 'r1' }, noBody: true, call: (repos: FleetReposController) => repos.remove('r1') },
    { key: 'fleet.repo.check', variant: 'rest:fleet-repos.check', input: { id: 'r1' }, noBody: false, call: (repos: FleetReposController) => repos.check('r1') },
    { key: 'fleet.repo.review.configure', variant: 'rest:fleet-repos.auto-review', input: { id: 'r1', patch: { enabled: false } }, noBody: false, call: (repos: FleetReposController) => repos.configureAutoReview('r1', { enabled: false }) },
  ];
  for (const c of cases) {
    it(`${c.key}: global gate, pending exception and executed response`, async () => {
      const service = { create: vi.fn(), remove: vi.fn(), check: vi.fn(), configureAutoReview: vi.fn() };
      const request = { id: 'q1' };
      const run = vi.fn().mockResolvedValue({ status: 'pending', request });
      const controller = construct<FleetReposController>(FleetReposController, service as unknown as FleetReposService, { run });
      await expect(c.call(controller)).rejects.toMatchObject({ name: 'ApprovalPending', request });
      expect(run).toHaveBeenCalledExactlyOnceWith({ key: c.key, variant: c.variant, projectId: null, input: c.input });
      const result = { id: 'r1' };
      run.mockResolvedValue({ status: 'executed', result });
      expect(await c.call(controller)).toEqual(c.noBody ? undefined : JsonResponse.Ok(result));
      for (const fn of Object.values(service)) expect(fn).not.toHaveBeenCalled();
    });
  }
  for (const action of ['update', 'delete'] as const) {
    it(`fleet.runner.${action}: global gate and 204 preservation`, async () => {
      const service = { update: vi.fn(), remove: vi.fn() };
      const run = vi.fn().mockResolvedValue({ status: 'pending', request: { id: 'q1' } });
      const controller = construct<RunnersController>(RunnersController, service as unknown as RunnersService, { run } as unknown as ApprovalRouteGate);
      const call = () => action === 'update' ? controller.update('r1', { enabled: false }) : controller.remove('r1');
      await expect(call()).rejects.toBeInstanceOf(ApprovalPending);
      expect(run).toHaveBeenCalledExactlyOnceWith({ key: `fleet.runner.${action}`, variant: `rest:fleet-runners.${action}`, projectId: null, input: action === 'update' ? { id: 'r1', patch: { enabled: false } } : { id: 'r1' } });
      run.mockResolvedValue({ status: 'executed', result: { enabled: false } });
      expect(await call()).toEqual(action === 'update' ? JsonResponse.Ok({ enabled: false }) : undefined);
      expect(service.update).not.toHaveBeenCalled();
      expect(service.remove).not.toHaveBeenCalled();
    });
  }
  it('analytics keeps query stripping before a globally scoped gate even with a project filter', async () => {
    const service = { deleteRows: vi.fn() };
    const run = vi.fn().mockResolvedValue({ status: 'pending', request: { id: 'q1' } });
    const controller = construct<FleetAnalyticsController>(FleetAnalyticsController, service as unknown as AnalyticsService, { run });
    const before = '2026-01-01T00:00:00Z';
    const call = () => controller.remove({ before, projectId: 'p1', extra: true } as { before: string; projectId: string }, { confirm: 'web' });
    await expect(call()).rejects.toBeInstanceOf(ApprovalPending);
    expect(run).toHaveBeenCalledExactlyOnceWith({ key: 'fleet.analytics.delete', variant: 'rest:fleet-analytics.delete', projectId: null, input: { before, projectId: 'p1', confirm: 'web' } });
    run.mockResolvedValue({ status: 'executed', result: { costEvents: 1 } });
    expect(await call()).toEqual(JsonResponse.Ok({ costEvents: 1 }));
    expect(service.deleteRows).not.toHaveBeenCalled();
  });
});
