import { Injectable, type OnModuleInit } from '@nestjs/common';
import { ApprovalCommandRegistry } from '../approvals/approval-command.registry';
import { parseRouteInput } from '../approvals/route/parse-route-input';
import { routeCommand } from '../approvals/route/route-command';
import { ActorPrincipalLoader } from '../auth/principal/actor-principal.loader';
import { SkillsService } from './skills.service';

export const SKILL_SOURCE_ROUTE_VARIANTS = { delete: 'rest:admin-skill-sources.delete' } as const;

@Injectable()
export class SkillSourceRouteCommands implements OnModuleInit {
  constructor(
    private readonly commands: ApprovalCommandRegistry,
    private readonly service: SkillsService,
    private readonly loader: ActorPrincipalLoader,
  ) {}

  onModuleInit(): void {
    this.commands.register(routeCommand<{ id: string }, null>({
      key: 'skill.source.delete', variant: SKILL_SOURCE_ROUTE_VARIANTS.delete,
      parse: (input) => parseRouteInput(input, ['id']),
      run: async (_principal, input) => {
        await this.service.deleteSource(input.id);
        return null;
      },
    }, this.loader));
  }
}
