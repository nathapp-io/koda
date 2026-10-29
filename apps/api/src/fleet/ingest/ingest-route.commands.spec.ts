import { ValidationAppException } from '@nathapp/nestjs-common';
import { ApprovalCommandRegistry } from '../../approvals/approval-command.registry';
import type { ActorPrincipalLoader } from '../../auth/principal/actor-principal.loader';
import type { IngestRequeueService } from './ingest-requeue.service';
import { IngestRouteCommands, INGEST_ROUTE_VARIANTS } from './ingest-route.commands';

function build() {
  const registry = new ApprovalCommandRegistry();
  const service = { backfill: vi.fn().mockResolvedValue({ queued: 1 }), rerunJob: vi.fn().mockResolvedValue({ queued: 2 }), rerunOutdated: vi.fn().mockResolvedValue({ queued: 3 }) };
  const loader = { forContext: vi.fn().mockResolvedValue({ id: 'a1', actorType: 'agent' }) };
  new IngestRouteCommands(registry, service as unknown as IngestRequeueService, loader as unknown as ActorPrincipalLoader).onModuleInit();
  return { registry, service };
}
describe('IngestRouteCommands', () => {
  it('AC-13: registers all global ingest variants', () => {
    const { registry } = build();
    expect(registry.get('fleet.ingest.backfill', 'rest:fleet-ingest.backfill')?.key).toBe('fleet.ingest.backfill');
    for (const variant of ['rest:fleet-ingest.rerun-job', 'rest:fleet-ingest.rerun-outdated']) expect(registry.get('fleet.ingest.rerun', variant)?.key).toBe('fleet.ingest.rerun');
  });
  it('AC-14: reruns as the reloaded requester with the frozen job id', async () => {
    const { registry, service } = build();
    const command = registry.get('fleet.ingest.rerun', INGEST_ROUTE_VARIANTS.rerunJob);
    if (!command) throw new Error('Missing job rerun command');
    expect(await command.execute(command.parse({ jobId: 'j1', ignored: true }))).toEqual({ queued: 2 });
    expect(service.rerunJob).toHaveBeenCalledExactlyOnceWith('a1', 'j1');
    expect(command.toResult?.({ queued: 2 })).toEqual({ queued: 2 });
    for (const input of [null, {}, { jobId: '' }, { jobId: 1 }]) expect(() => command.parse(input)).toThrow(ValidationAppException);
  });
  it.each([['fleet.ingest.backfill', 'backfill'], ['fleet.ingest.rerun', 'rerunOutdated']] as const)('executes %s empty input', async (key, method) => {
    const { registry, service } = build();
    const command = registry.get(key, INGEST_ROUTE_VARIANTS[method]);
    if (!command) throw new Error('Missing ingest command');
    const result = await command.execute(command.parse({ ignored: true }));
    expect(service[method]).toHaveBeenCalledExactlyOnceWith('a1');
    expect(command.toResult?.(result)).toEqual(result);
  });
});
