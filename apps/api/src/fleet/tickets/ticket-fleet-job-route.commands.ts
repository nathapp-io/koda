import { Injectable, type OnModuleInit } from '@nestjs/common';
import { ApprovalCommandRegistry } from '../../approvals/approval-command.registry';
import { parseRouteInput } from '../../approvals/route/parse-route-input';
import { routeCommand } from '../../approvals/route/route-command';
import { ActorPrincipalLoader } from '../../auth/principal/actor-principal.loader';
import { FleetTicketsService } from './fleet-tickets.service';

export const TICKET_FLEET_JOB_ROUTE_VARIANTS = {
  unlink: 'rest:ticket-fleet-jobs.unlink',
} as const;

@Injectable()
export class TicketFleetJobRouteCommands implements OnModuleInit {
  constructor(
    private readonly commands: ApprovalCommandRegistry,
    private readonly fleetTickets: FleetTicketsService,
    private readonly loader: ActorPrincipalLoader,
  ) {}

  onModuleInit(): void {
    this.commands.register(routeCommand<{ slug: string; projectId: string; ref: string; jobId: string }, null>({
      key: 'fleet.ticket-job.unlink', variant: TICKET_FLEET_JOB_ROUTE_VARIANTS.unlink,
      parse: (input) => parseRouteInput(input, ['slug', 'projectId', 'ref', 'jobId']),
      run: async (principal, input) => {
        await this.fleetTickets.unlink(input.projectId, input.ref, input.jobId, principal.id);
        return null;
      },
    }, this.loader));
  }
}
