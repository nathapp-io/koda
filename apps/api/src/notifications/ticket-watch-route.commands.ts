import { Injectable, type OnModuleInit } from '@nestjs/common';
import { ForbiddenAppException } from '@nathapp/nestjs-common';
import { ApprovalCommandRegistry } from '../approvals/approval-command.registry';
import { parseRouteInput } from '../approvals/route/parse-route-input';
import { routeCommand } from '../approvals/route/route-command';
import { ActorPrincipalLoader } from '../auth/principal/actor-principal.loader';
import type { AgentPrincipal, UserPrincipal } from '../auth/principal/koda-principal.types';
import { TicketWatchService } from './ticket-watch.service';

export const TICKET_WATCH_ROUTE_VARIANTS = {
  set: 'rest:ticket-watch.set',
  unset: 'rest:ticket-watch.unset',
} as const;

export function userOf(principal: UserPrincipal | AgentPrincipal): UserPrincipal {
  if (principal.actorType !== 'user') throw new ForbiddenAppException({}, 'notifications');
  return principal;
}

@Injectable()
export class TicketWatchRouteCommands implements OnModuleInit {
  constructor(
    private readonly commands: ApprovalCommandRegistry,
    private readonly watch: TicketWatchService,
    private readonly loader: ActorPrincipalLoader,
  ) {}

  onModuleInit(): void {
    this.commands.register(routeCommand<{ projectId: string; ref: string }, Awaited<ReturnType<TicketWatchService['watch']>>>({
      key: 'ticket.watch.set', variant: TICKET_WATCH_ROUTE_VARIANTS.set,
      parse: (input) => parseRouteInput(input, ['projectId', 'ref']),
      run: (principal, input) => this.watch.watch(input.projectId, input.ref, userOf(principal).id),
      toResult: (result) => result,
    }, this.loader));
    this.commands.register(routeCommand<{ projectId: string; ref: string }, Awaited<ReturnType<TicketWatchService['unwatch']>>>({
      key: 'ticket.watch.unset', variant: TICKET_WATCH_ROUTE_VARIANTS.unset,
      parse: (input) => parseRouteInput(input, ['projectId', 'ref']),
      run: (principal, input) => this.watch.unwatch(input.projectId, input.ref, userOf(principal).id),
      toResult: (result) => result,
    }, this.loader));
  }
}
