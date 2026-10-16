import { Inject, Injectable } from '@nestjs/common';
import { ConfigType } from '@nestjs/config';
import { CaslPermissionAction } from '@nathapp/nestjs-auth';
import { ForbiddenAppException, NotFoundAppException } from '@nathapp/nestjs-common';
import { KodaCaslAbilityFactory } from '../../auth/casl/koda-casl-ability.factory';
import type { UserPrincipal } from '../../auth/principal/koda-principal.types';
import { ConflictAppException } from '../../common/exceptions/conflict-app.exception';
import { FLEET_CFG, fleetConfig } from '../../config/fleet.config';
import { ProjectAccessService } from '../../projects/project-access.service';
import { ProjectsService } from '../../projects/projects.service';
import { withProjectRole } from '../../projects/project-context';
import { SkillsService } from '../../skills/skills.service';
import { FLEET_REPO_REPOSITORY, type IFleetRepoRepository } from '../repos/domain/fleet-repo.domain';
import { CHAT_THREAD_REPOSITORY, type ChatThreadRecord, type ChatThreadRepository } from './domain/chat-thread.domain';
import { validateCreateWorkspaceThread, type CreateWorkspaceThreadInput } from './thread-input';

@Injectable()
export class WorkspaceThreadsService {
  constructor(
    @Inject(CHAT_THREAD_REPOSITORY) private readonly threads: ChatThreadRepository,
    @Inject(FLEET_REPO_REPOSITORY) private readonly repos: IFleetRepoRepository,
    private readonly skills: SkillsService,
    @Inject(FLEET_CFG) private readonly config: ConfigType<typeof fleetConfig>,
    private readonly projects: ProjectsService,
    private readonly access: ProjectAccessService,
    private readonly casl: KodaCaslAbilityFactory,
  ) {}

  async create(principal: UserPrincipal, input: CreateWorkspaceThreadInput): Promise<ChatThreadRecord> {
    if (!this.config.threadsEnabled) throw new ConflictAppException({}, 'threads.disabled');
    const normalized = validateCreateWorkspaceThread(input);
    const reachable = await this.projects.findAllForPrincipal(principal);
    let home: typeof reachable[number] | undefined;
    if (normalized.homeProject !== undefined) {
      home = reachable.find(project => project.slug === normalized.homeProject);
      // Only inspect reachable projects: unknown and inaccessible slugs are indistinguishable.
      if (!home) throw new NotFoundAppException({}, 'projects');
      if (!await this.canHost(home.id, principal)) throw new ForbiddenAppException({}, 'threads.homeProjectAccess');
      if (!await this.repos.findAnchor(home.id)) throw new ConflictAppException({}, 'threads.noFleetRepo');
    } else {
      reachable.sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime() || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
      for (const project of reachable) {
        // Admin reach alone must not pick an unrelated project as the default home.
        if (await this.access.findMembershipRole(project.id, principal.id) === null) continue;
        if (!await this.canHost(project.id, principal)) continue;
        if (!await this.repos.findAnchor(project.id)) continue;
        home = project;
        break;
      }
      if (!home) throw new ConflictAppException({}, 'threads.noFleetRepo');
    }
    const skills = await this.skills.snapshotForProject(home.id);
    const thread = await this.threads.create({ kind: 'WORKSPACE', projectId: home.id, repoId: null, baseRef: null, feature: null, title: normalized.title, createdById: principal.id, backend: normalized.backend, skills, maxCostUsd: normalized.maxCostUsd });
    return { ...thread, homeProject: { slug: home.slug, name: home.name } };
  }

  private async canHost(projectId: string, principal: UserPrincipal): Promise<boolean> {
    const role = await this.access.resolveMembership(projectId, principal);
    const ability = await this.casl.createForUser(withProjectRole(principal, role));
    return ability.can(CaslPermissionAction.CREATE, 'FleetJob');
  }
}
