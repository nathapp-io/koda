import { ValidationAppException } from '@nathapp/nestjs-common';
import { ApprovalCommandRegistry } from '../../approvals/approval-command.registry';
import type { ActorPrincipalLoader } from '../../auth/principal/actor-principal.loader';
import type { AgentPrincipal } from '../../auth/principal/koda-principal.types';
import type { FleetJobsService } from './fleet-jobs.service';
import { FleetJobRouteCommands, FLEET_JOB_ROUTE_VARIANTS } from './fleet-job-route.commands';

const dto = { repoId: 'r1', command: 'RUN', feature: 'gated', maxCostUsd: 5 };
function build() {
  const registry = new ApprovalCommandRegistry();
  const principal = { id: 'a1', actorType: 'agent', slug: 'agent', status: 'ACTIVE', capabilities: [] } satisfies AgentPrincipal;
  const loader = { forContext: vi.fn().mockResolvedValue(principal) };
  const result = { job: { id: 'j1' }, placement: {} };
  const jobs = { dispatch: vi.fn().mockResolvedValue(result), requeue: vi.fn().mockResolvedValue(result) };
  new FleetJobRouteCommands(registry, jobs as unknown as FleetJobsService, loader as unknown as ActorPrincipalLoader).onModuleInit();
  const dispatch = registry.get('fleet.job.dispatch', FLEET_JOB_ROUTE_VARIANTS.dispatch);
  const requeue = registry.get('fleet.job.requeue', FLEET_JOB_ROUTE_VARIANTS.requeue);
  if (!dispatch?.toResult || !requeue?.toResult) throw new Error('Missing fleet route command or result mapper');
  return { registry, dispatch, requeue, principal, loader, jobs, result };
}
describe('FleetJobRouteCommands', () => {
  it('AC-10: registers both REST variants', () => {
    const { dispatch, requeue } = build();
    expect(dispatch).toMatchObject({ key: 'fleet.job.dispatch', variant: 'rest:fleet-jobs.dispatch' });
    expect(requeue).toMatchObject({ key: 'fleet.job.requeue', variant: 'rest:fleet-jobs.requeue' });
  });
  it('AC-11: dispatches as the reloaded requester with the frozen ticket actor and slug', async () => {
    const { dispatch, principal, loader, jobs, result } = build();
    const input = dispatch.parse({ slug: 'web', projectId: 'p1', dispatch: dto, ignored: true });
    expect(input).toEqual({ slug: 'web', projectId: 'p1', dispatch: dto });
    expect(await dispatch.execute(input)).toBe(result);
    expect(loader.forContext).toHaveBeenCalledOnce();
    expect(jobs.dispatch).toHaveBeenCalledExactlyOnceWith('a1', 'p1', dto, { ticketActor: { principal, projectSlug: 'web' } });
    expect(dispatch.toResult?.(result)).toBe(result);
  });
  it('AC-12: requeues as the reloaded requester', async () => {
    const { requeue, jobs, result } = build();
    const input = requeue.parse({ slug: 'web', projectId: 'p1', id: 'j1' });
    expect(await requeue.execute(input)).toBe(result);
    expect(jobs.requeue).toHaveBeenCalledExactlyOnceWith('a1', 'p1', 'j1');
    expect(requeue.toResult?.(result)).toBe(result);
  });
  it('rejects malformed identifiers and missing or invalid dispatch bodies', () => {
    const { dispatch, requeue } = build();
    for (const input of [null, [], {}, { slug: '', projectId: 'p1', dispatch: dto }, { slug: 'web', projectId: 2, dispatch: dto }, { slug: 'web', projectId: 'p1' }, { slug: 'web', projectId: 'p1', dispatch: { ...dto, maxCostUsd: -1 } }]) {
      expect(() => dispatch.parse(input)).toThrow(ValidationAppException);
    }
    expect(() => requeue.parse({ slug: 'web', projectId: 'p1', id: '' })).toThrow(ValidationAppException);
  });
});
