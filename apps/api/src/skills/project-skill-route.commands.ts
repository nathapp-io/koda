import { Injectable, type OnModuleInit } from '@nestjs/common';
import { ApprovalCommandRegistry } from '../approvals/approval-command.registry';
import { parseRouteInput } from '../approvals/route/parse-route-input';
import { routeCommand } from '../approvals/route/route-command';
import { ActorPrincipalLoader } from '../auth/principal/actor-principal.loader';
import { ProjectSkillDto } from './dto/project-skill.dto';
import { SkillsService } from './skills.service';

export const PROJECT_SKILL_ROUTE_VARIANTS = {
  enable: 'rest:project-skills.enable',
  disable: 'rest:project-skills.disable',
} as const;

type ProjectSkillInput = { slug: string; projectId: string; skillId: string };

@Injectable()
export class ProjectSkillRouteCommands implements OnModuleInit {
  constructor(
    private readonly commands: ApprovalCommandRegistry,
    private readonly skills: SkillsService,
    private readonly loader: ActorPrincipalLoader,
  ) {}

  onModuleInit(): void {
    this.commands.register(routeCommand<ProjectSkillInput, ProjectSkillDto>({
      key: 'skill.project.enable', variant: PROJECT_SKILL_ROUTE_VARIANTS.enable,
      parse: (input) => parseRouteInput(input, ['slug', 'projectId', 'skillId']),
      run: async (principal, input) => ProjectSkillDto.fromDomain(
        await this.skills.enableProjectSkill(input.projectId, input.skillId, principal.id),
      ),
      toResult: (result) => result,
    }, this.loader));
    this.commands.register(routeCommand<ProjectSkillInput, null>({
      key: 'skill.project.disable', variant: PROJECT_SKILL_ROUTE_VARIANTS.disable,
      parse: (input) => parseRouteInput(input, ['slug', 'projectId', 'skillId']),
      run: async (_principal, input) => {
        await this.skills.disableProjectSkill(input.projectId, input.skillId);
        return null;
      },
    }, this.loader));
  }
}
