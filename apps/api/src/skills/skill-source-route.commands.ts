import { Injectable, type OnModuleInit } from '@nestjs/common';
import { ApprovalCommandRegistry } from '../approvals/approval-command.registry';
import { parseRouteInput } from '../approvals/route/parse-route-input';
import { routeCommand } from '../approvals/route/route-command';
import { ActorPrincipalLoader } from '../auth/principal/actor-principal.loader';
import { SkillsService } from './skills.service';
import { parseBody } from '../approvals/route/parse-body';
import { CreateSkillSourceDto, SkillSourceDto } from './dto/skill-source.dto';

export const SKILL_SOURCE_ROUTE_VARIANTS = {
  create: 'rest:admin-skill-sources.create',
  update: 'rest:admin-skill-sources.update',
  delete: 'rest:admin-skill-sources.delete',
} as const;

@Injectable()
export class SkillSourceRouteCommands implements OnModuleInit {
  constructor(
    private readonly commands: ApprovalCommandRegistry,
    private readonly service: SkillsService,
    private readonly loader: ActorPrincipalLoader,
  ) {}

  onModuleInit(): void {
    this.commands.register(routeCommand<{ source: CreateSkillSourceDto }, SkillSourceDto>({
      key: 'skill.source.create', variant: SKILL_SOURCE_ROUTE_VARIANTS.create,
      parse: (input) => {
        parseRouteInput(input, []);
        return { source: parseBody(CreateSkillSourceDto, (input as Record<string, unknown>)['source'] ?? {}) };
      },
      prepare: async (principal, input) => {
        const apply = await this.service.prepareCreateSource(input.source, principal);
        return async () => SkillSourceDto.fromDomain(await apply());
      },
      run: async (principal, input) => SkillSourceDto.fromDomain(await this.service.createSource(input.source, principal)),
      toResult: (result) => result,
    }, this.loader));
    this.commands.register(routeCommand<{ id: string }, SkillSourceDto>({
      key: 'skill.source.update', variant: SKILL_SOURCE_ROUTE_VARIANTS.update,
      parse: (input) => parseRouteInput(input, ['id']),
      prepare: async (_principal, input) => {
        const apply = await this.service.prepareUpdateSource(input.id);
        return async () => SkillSourceDto.fromDomain(await apply());
      },
      run: async (_principal, input) => SkillSourceDto.fromDomain(await this.service.updateSource(input.id)),
      toResult: (result) => result,
    }, this.loader));
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
