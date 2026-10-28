import { Injectable, type OnModuleInit } from '@nestjs/common';
import { ApprovalCommandRegistry } from '../approvals/approval-command.registry';
import { parseRouteInput } from '../approvals/route/parse-route-input';
import { routeCommand } from '../approvals/route/route-command';
import { ActorPrincipalLoader } from '../auth/principal/actor-principal.loader';
import { WebhookService } from './webhook.service';

export const WEBHOOK_ROUTE_VARIANTS = {
  projectDelete: 'rest:project-webhooks.delete',
  globalDelete: 'rest:webhooks.delete',
} as const;

@Injectable()
export class WebhookRouteCommands implements OnModuleInit {
  constructor(
    private readonly commands: ApprovalCommandRegistry,
    private readonly webhooks: WebhookService,
    private readonly loader: ActorPrincipalLoader,
  ) {}

  onModuleInit(): void {
    this.commands.register(routeCommand<{ projectId: string; id: string }, null>({
      key: 'webhook.delete', variant: WEBHOOK_ROUTE_VARIANTS.projectDelete,
      parse: (input) => parseRouteInput(input, ['projectId', 'id']),
      run: async (_principal, input) => {
        await this.webhooks.removeForProject(input.projectId, input.id);
        return null;
      },
    }, this.loader));
    this.commands.register(routeCommand<{ id: string }, null>({
      key: 'webhook.delete', variant: WEBHOOK_ROUTE_VARIANTS.globalDelete,
      parse: (input) => parseRouteInput(input, ['id']),
      run: async (_principal, input) => {
        await this.webhooks.remove(input.id);
        return null;
      },
    }, this.loader));
  }
}
