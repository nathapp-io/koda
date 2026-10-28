import { Injectable, type OnModuleInit } from '@nestjs/common';
import { ApprovalCommandRegistry } from '../approvals/approval-command.registry';
import { parseRouteInput } from '../approvals/route/parse-route-input';
import { routeCommand } from '../approvals/route/route-command';
import { ActorPrincipalLoader } from '../auth/principal/actor-principal.loader';
import { ProjectsService } from './projects.service';

export const PROJECT_ROUTE_VARIANTS = { delete: 'rest:projects.delete' } as const;

@Injectable()
export class ProjectRouteCommands implements OnModuleInit {
  constructor(
    private readonly commands: ApprovalCommandRegistry,
    private readonly service: ProjectsService,
    private readonly loader: ActorPrincipalLoader,
  ) {}

  onModuleInit(): void {
    this.commands.register(routeCommand<{ slug: string }, null>({
      key: 'project.delete', variant: PROJECT_ROUTE_VARIANTS.delete,
      parse: (input) => parseRouteInput(input, ['slug']),
      run: async (_principal, input) => {
        await this.service.softDelete(input.slug);
        return null;
      },
    }, this.loader));
  }
}
