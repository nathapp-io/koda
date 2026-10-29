import { ValidationAppException } from '@nathapp/nestjs-common';
import { ApprovalCommandRegistry } from '../../approvals/approval-command.registry';
import type { ActorPrincipalLoader } from '../../auth/principal/actor-principal.loader';
import type { AgentPrincipal } from '../../auth/principal/koda-principal.types';
import type { FleetTicketsService } from './fleet-tickets.service';
import { TicketFleetJobRouteCommands, TICKET_FLEET_JOB_ROUTE_VARIANTS } from './ticket-fleet-job-route.commands';

describe('TicketFleetJobRouteCommands', () => {
  const build = () => {
    const registry = new ApprovalCommandRegistry();
    const principal = { id: 'a1', actorType: 'agent', slug: 'agent', status: 'ACTIVE', capabilities: [] } satisfies AgentPrincipal;
    const loader = { forContext: vi.fn().mockResolvedValue(principal) };
    const service = { unlink: vi.fn().mockResolvedValue(undefined) };
    new TicketFleetJobRouteCommands(registry, service as unknown as FleetTicketsService, loader as unknown as ActorPrincipalLoader).onModuleInit();
    const command = registry.get('fleet.ticket-job.unlink', TICKET_FLEET_JOB_ROUTE_VARIANTS.unlink);
    if (!command) throw new Error('Missing unlink command');
    return { command, service, loader };
  };
  it('AC-13: registers the unlink REST variant without a result mapper', () => {
    const { command } = build();
    expect(command).toMatchObject({ key: 'fleet.ticket-job.unlink', variant: 'rest:ticket-fleet-jobs.unlink' });
    expect(command.toResult).toBeUndefined();
  });
  it('AC-14: unlinks as the reloaded requester and answers null', async () => {
    const { command, service, loader } = build();
    const input = command.parse({ slug: 'web', projectId: 'p1', ref: 'WEB-1', jobId: 'j1', ignored: true });
    expect(input).toEqual({ slug: 'web', projectId: 'p1', ref: 'WEB-1', jobId: 'j1' });
    expect(await command.execute(input)).toBeNull();
    expect(service.unlink).toHaveBeenCalledExactlyOnceWith('p1', 'WEB-1', 'j1', 'a1');
    expect(loader.forContext).toHaveBeenCalledOnce();
  });
  it.each(['slug', 'projectId', 'ref', 'jobId'])('rejects invalid %s', (field) => {
    const { command } = build();
    expect(() => command.parse({ slug: 'web', projectId: 'p1', ref: 'WEB-1', jobId: 'j1', [field]: '' })).toThrow(ValidationAppException);
  });
});
