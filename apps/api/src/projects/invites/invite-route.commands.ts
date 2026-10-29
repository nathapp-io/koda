import { Injectable, type OnModuleInit } from '@nestjs/common';
import { ApprovalCommandRegistry } from '../../approvals/approval-command.registry';
import { parseRouteInput } from '../../approvals/route/parse-route-input';
import { routeCommand } from '../../approvals/route/route-command';
import { ActorPrincipalLoader } from '../../auth/principal/actor-principal.loader';
import { ProjectInvitesService } from './project-invites.service';

export const INVITE_ROUTE_VARIANTS = { cancel: 'rest:project-invites.cancel' } as const;

@Injectable()
export class InviteRouteCommands implements OnModuleInit {
  constructor(
    private readonly commands: ApprovalCommandRegistry,
    private readonly invites: ProjectInvitesService,
    private readonly loader: ActorPrincipalLoader,
  ) {}

  onModuleInit(): void {
    this.commands.register(routeCommand<{ slug: string; id: string }, null>({
      key: 'invite.cancel', variant: INVITE_ROUTE_VARIANTS.cancel,
      parse: (input) => parseRouteInput(input, ['slug', 'id']),
      run: async (principal, input) => {
        await this.invites.cancel(input.slug, input.id, principal);
        return null;
      },
    }, this.loader));
  }
}
