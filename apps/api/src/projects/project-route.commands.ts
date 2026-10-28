import { Injectable, type OnModuleInit } from '@nestjs/common';
import { ValidationAppException } from '@nathapp/nestjs-common';
import { ApprovalCommandRegistry } from '../approvals/approval-command.registry';
import { parseBody } from '../approvals/route/parse-body';
import { parseRouteInput } from '../approvals/route/parse-route-input';
import { routeCommand } from '../approvals/route/route-command';
import { ActorPrincipalLoader } from '../auth/principal/actor-principal.loader';
import { ProjectsService } from './projects.service';
import { CreateProjectDto } from './dto/create-project.dto';
import { UpdateProjectDto } from './dto/update-project.dto';

export const PROJECT_ROUTE_VARIANTS = {
  create: 'rest:projects.create',
  update: 'rest:projects.update',
  delete: 'rest:projects.delete',
} as const;

@Injectable()
export class ProjectRouteCommands implements OnModuleInit {
  constructor(
    private readonly commands: ApprovalCommandRegistry,
    private readonly service: ProjectsService,
    private readonly loader: ActorPrincipalLoader,
  ) {}

  onModuleInit(): void {
    this.commands.register(routeCommand<CreateProjectDto, Awaited<ReturnType<ProjectsService['create']>>>({
      key: 'project.create', variant: PROJECT_ROUTE_VARIANTS.create,
      parse: (input) => parseBody(CreateProjectDto, input),
      run: async (_principal, input) => this.service.create(input),
      toResult: (result) => result,
    }, this.loader));
    this.commands.register(routeCommand<{ slug: string; patch: UpdateProjectDto }, Awaited<ReturnType<ProjectsService['update']>>>({
      key: 'project.update', variant: PROJECT_ROUTE_VARIANTS.update,
      parse: (input) => {
        const { slug } = parseRouteInput(input, ['slug']);
        const source = typeof input === 'object' && input !== null ? input as Record<string, unknown> : {};
        const patch = parseBody(UpdateProjectDto, source.patch ?? {});
        // Defense in depth: direct registry callers must not persist secrets either.
        if (patch.ciWebhookToken !== undefined) throw new ValidationAppException({}, 'approvals.invalidInput');
        return { slug, patch };
      },
      run: async (_principal, input) => this.service.update(input.slug, input.patch),
      toResult: (result) => result,
    }, this.loader));
    this.commands.register(routeCommand<{ slug: string; projectId: string }, null>({
      key: 'project.delete', variant: PROJECT_ROUTE_VARIANTS.delete,
      parse: (input) => parseRouteInput(input, ['slug', 'projectId']),
      run: async (_principal, input) => {
        await this.service.softDeleteById(input.projectId);
        return null;
      },
    }, this.loader));
  }
}
