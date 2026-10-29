import { Injectable, type OnModuleInit } from '@nestjs/common';
import { ApprovalCommandRegistry } from '../approvals/approval-command.registry';
import { parseRouteInput } from '../approvals/route/parse-route-input';
import { routeCommand } from '../approvals/route/route-command';
import { ActorPrincipalLoader } from '../auth/principal/actor-principal.loader';
import { OutboxAdminService } from './outbox-admin.service';

export const OUTBOX_ROUTE_VARIANTS = { retry: 'rest:admin-outbox.retry' } as const;

@Injectable()
export class OutboxRouteCommands implements OnModuleInit {
  constructor(
    private readonly commands: ApprovalCommandRegistry,
    private readonly outboxAdmin: OutboxAdminService,
    private readonly loader: ActorPrincipalLoader,
  ) {}

  onModuleInit(): void {
    this.commands.register(routeCommand<{ eventId: string }, null>({
      key: 'outbox.retry', variant: OUTBOX_ROUTE_VARIANTS.retry,
      parse: (input) => parseRouteInput(input, ['eventId']),
      run: async (_principal, input) => {
        await this.outboxAdmin.retry(input.eventId);
        return null;
      },
    }, this.loader));
  }
}
