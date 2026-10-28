import { Injectable, type OnModuleInit } from '@nestjs/common';
import { ApprovalCommandRegistry } from '../approvals/approval-command.registry';
import { parseRouteInput } from '../approvals/route/parse-route-input';
import { routeCommand } from '../approvals/route/route-command';
import { ActorPrincipalLoader } from '../auth/principal/actor-principal.loader';
import { LabelsService } from './labels.service';

export const LABEL_ROUTE_VARIANTS = { delete: 'rest:labels.delete', remove: 'rest:ticket-labels.remove' } as const;

@Injectable()
export class LabelRouteCommands implements OnModuleInit {
  constructor(
    private readonly commands: ApprovalCommandRegistry,
    private readonly service: LabelsService,
    private readonly loader: ActorPrincipalLoader,
  ) {}

  onModuleInit(): void {
    this.commands.register(routeCommand<{ slug: string; id: string }, null>({
      key: 'label.delete', variant: LABEL_ROUTE_VARIANTS.delete,
      parse: (input) => parseRouteInput(input, ['slug', 'id']),
      run: async (principal, input) => {
        await this.service.delete(input.slug, input.id, principal);
        return null;
      },
    }, this.loader));
    this.commands.register(routeCommand<{ slug: string; ref: string; labelId: string }, null>({
      key: 'ticket.label.remove', variant: LABEL_ROUTE_VARIANTS.remove,
      parse: (input) => parseRouteInput(input, ['slug', 'ref', 'labelId']),
      run: async (principal, input) => {
        await this.service.removeFromTicket(input.slug, input.ref, input.labelId, principal);
        return null;
      },
    }, this.loader));
  }
}
