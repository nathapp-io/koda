import { Inject, Injectable } from '@nestjs/common';
import { ConfigType } from '@nestjs/config';
import { CaslPermissionAction } from '@nathapp/nestjs-auth';
import { ForbiddenAppException, NotFoundAppException, ValidationAppException } from '@nathapp/nestjs-common';
import { KodaCaslAbilityFactory } from '../../auth/casl/koda-casl-ability.factory';
import type { UserPrincipal } from '../../auth/principal/koda-principal.types';
import { ConflictAppException } from '../../common/exceptions/conflict-app.exception';
import { FleetCommandType } from '../../common/enums';
import { FLEET_CFG, fleetConfig } from '../../config/fleet.config';
import { ProjectAccessService } from '../../projects/project-access.service';
import { ProjectsService } from '../../projects/projects.service';
import { withProjectRole } from '../../projects/project-context';
import { SkillsService } from '../../skills/skills.service';
import { FLEET_REPO_REPOSITORY, type IFleetRepoRepository } from '../repos/domain/fleet-repo.domain';
import { CHAT_THREAD_REPOSITORY, type ChatMessageRecord, type ChatThreadDetail, type ChatThreadRecord, type ChatThreadRepository } from './domain/chat-thread.domain';
import { isMaxCostUsd, validateCreateWorkspaceThread, type CreateWorkspaceThreadInput } from './thread-input';
import type { AnswerQuestionDto } from './dto/thread.dto';

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

  /**
   * The workspace scope's own read (1d-D2, 1d-D10): a thread that is not this user's WORKSPACE thread — another
   * user's, a global admin's, or another kind — answers 404, and the events guard shares this fence.
   */
  async requireOwnedThread(userId: string, id: string): Promise<ChatThreadRecord> {
    const thread = await this.threads.get({ kind: 'workspace', userId }, id);
    if (!thread) throw new NotFoundAppException({}, 'threads.notFound');
    return thread;
  }

  async list(userId: string, status: string | undefined, skip: number, take: number): Promise<{ items: ChatThreadRecord[]; threadsEnabled: boolean }> {
    return { items: await this.threads.list({ kind: 'workspace', userId }, status, skip, take), threadsEnabled: this.config.threadsEnabled };
  }

  async get(userId: string, id: string): Promise<ChatThreadDetail> {
    const thread = await this.requireOwnedThread(userId, id);
    const [sendRefusal, handoff] = await Promise.all([this.threads.sendRefusalOf(thread.projectId, thread), this.threads.handoff(thread.id)]);
    return { ...thread, sendRefusal, handoff };
  }

  async messages(userId: string, id: string, afterSeq: number, limit: number): Promise<{ items: ChatMessageRecord[] }> {
    const thread = await this.requireOwnedThread(userId, id);
    return { items: await this.threads.messages(thread.id, afterSeq, limit) };
  }

  /**
   * The cap PATCH answers a `WorkspaceThreadDto`, and `updateCap` maps the row without the home-project include a
   * scoped read adds, so the route reads the project back and builds a new record rather than mutating the mapped one.
   */
  async updateCap(userId: string, id: string, value: unknown): Promise<ChatThreadRecord & { homeProject: { slug: string; name: string } }> {
    if (!isMaxCostUsd(value)) throw new ValidationAppException({ reason: 'maxCostUsd' }, 'threads.input');
    const updated = await this.threads.updateCap({ kind: 'workspace', userId }, id, userId, String(value));
    const stored = await this.requireOwnedThread(userId, id);
    if (!stored.homeProject) throw new NotFoundAppException({}, 'projects');
    return { ...updated, homeProject: stored.homeProject };
  }

  stop(userId: string, threadId: string): Promise<void> {
    return this.threads.command({ kind: 'workspace', userId }, threadId, userId, FleetCommandType.THREAD_STOP_TURN, {});
  }

  endSession(userId: string, threadId: string): Promise<void> {
    return this.threads.command({ kind: 'workspace', userId }, threadId, userId, FleetCommandType.THREAD_CLOSE, {});
  }

  async answer(userId: string, threadId: string, input: AnswerQuestionDto): Promise<void> {
    if (typeof input.requestId !== 'string' || input.requestId.length < 1 || input.requestId.length > 128 || typeof input.text !== 'string' || input.text.length < 1 || Buffer.byteLength(input.text, 'utf8') > 32768) throw new ValidationAppException({ reason: 'answer' }, 'threads.input');
    return this.threads.command({ kind: 'workspace', userId }, threadId, userId, FleetCommandType.THREAD_ANSWER, input);
  }

  private async canHost(projectId: string, principal: UserPrincipal): Promise<boolean> {
    const role = await this.access.resolveMembership(projectId, principal);
    const ability = await this.casl.createForUser(withProjectRole(principal, role));
    return ability.can(CaslPermissionAction.CREATE, 'FleetJob');
  }
}
