import { Inject, Injectable } from '@nestjs/common';
import { ConfigType } from '@nestjs/config';
import { ForbiddenAppException, NotFoundAppException, ValidationAppException } from '@nathapp/nestjs-common';
import { isUserPrincipal, type AgentPrincipal, type UserPrincipal } from '../../auth/principal/koda-principal.types';
import { ConflictAppException } from '../../common/exceptions/conflict-app.exception';
import { FleetCommandType } from '../../common/enums';
import { FLEET_CFG, fleetConfig } from '../../config/fleet.config';
import { PermissionService } from '../../permissions/permission.service';
import { ProjectAccessService } from '../../projects/project-access.service';
import { ProjectsService } from '../../projects/projects.service';
import { SkillsService } from '../../skills/skills.service';
import { FLEET_REPO_REPOSITORY, type IFleetRepoRepository } from '../repos/domain/fleet-repo.domain';
import { CHAT_THREAD_REPOSITORY, type ChatMessageRecord, type ChatThreadDetail, type ChatThreadRecord, type ChatThreadRepository } from './domain/chat-thread.domain';
import { isMaxCostUsd, validateCreateWorkspaceThread, type CreateWorkspaceThreadInput } from './thread-input';
import type { AnswerQuestionDto, SendMessageDto } from './dto/thread.dto';
import { FleetJobsService } from '../jobs/fleet-jobs.service';

/**
 * The personal (workspace) thread surface, authorized by permission keys (permissions P1 US-003).
 *
 * The workspace scope — `{ kind: 'workspace', userId }`, matched on `createdById` — fences every read and
 * write to the caller's own threads: another user's thread, a global admin's included, answers 404. The
 * route keys (`thread.workspace.*`) are checked by `RequiresGuard`; the four keys that act on one thread's
 * own rows (`thread.cap.update`, `thread.stop`, `thread.end-session`, `thread.answer`) are checked here, in
 * the thread's home project, on the row this service just loaded. Hosting a thread in a project is the
 * project's `thread.create` key.
 */
@Injectable()
export class WorkspaceThreadsService {
  constructor(
    @Inject(CHAT_THREAD_REPOSITORY) private readonly threads: ChatThreadRepository,
    @Inject(FLEET_REPO_REPOSITORY) private readonly repos: IFleetRepoRepository,
    private readonly skills: SkillsService,
    @Inject(FLEET_CFG) private readonly config: ConfigType<typeof fleetConfig>,
    private readonly projects: ProjectsService,
    private readonly access: ProjectAccessService,
    private readonly permissions: PermissionService,
    private readonly fleetJobs: FleetJobsService,
  ) {}

  async create(principal: UserPrincipal | AgentPrincipal, input: CreateWorkspaceThreadInput): Promise<ChatThreadRecord> {
    if (!this.config.threadsEnabled) throw new ConflictAppException({}, 'threads.disabled');
    const normalized = validateCreateWorkspaceThread(input);
    const reachable = await this.projects.findAllForPrincipal(principal);
    let home: typeof reachable[number] | undefined;
    if (normalized.homeProject !== undefined) {
      home = reachable.find(project => project.slug === normalized.homeProject);
      // Only inspect reachable projects: unknown and inaccessible slugs are indistinguishable.
      if (!home) throw new NotFoundAppException({}, 'projects');
      // US-003: hosting is the home project's `thread.create` key, and its refusal is the permissions code.
      if (!await this.canHost(home.id, principal)) throw new ForbiddenAppException({}, 'permissions');
      if (!await this.repos.findAnchor(home.id)) throw new ConflictAppException({}, 'threads.noFleetRepo');
    } else {
      reachable.sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime() || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
      for (const project of reachable) {
        // Reach alone must not pick an unrelated project as the default home.
        if (!await this.hasMembership(project.id, principal)) continue;
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
   * The default-home half of `create` (US-003): reach is not membership. A user needs a membership row in
   * the project (a legacy `ProjectMember` row or a project binding); an agent must be on the project's
   * roster, which `resolveMembership` answers with a `projects` 403 when it is not. Both are what stops a
   * global admin's — or a globally bound agent's — reach from choosing an arbitrary project as the home.
   */
  private async hasMembership(projectId: string, principal: UserPrincipal | AgentPrincipal): Promise<boolean> {
    if (isUserPrincipal(principal)) return (await this.access.findMembershipRole(projectId, principal.id)) !== null;
    try {
      await this.access.resolveMembership(projectId, principal);
      return true;
    } catch (error) {
      if (error instanceof ForbiddenAppException) return false;
      throw error;
    }
  }

  /**
   * The workspace scope's own read (1d-D2, 1d-D10): a thread that is not this principal's WORKSPACE thread
   * — another principal's, a global admin's, or another kind — answers 404, and the events guard shares this
   * fence.
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
    const scope = { kind: 'workspace', userId } as const;
    const thread = await this.requireOwnedThread(userId, id);
    const [sendRefusal, handoff, pendingActions] = await Promise.all([
      this.threads.sendRefusalOf(thread.projectId, thread), this.threads.handoff(thread.id), this.threads.pendingActions(scope, thread.id),
    ]);
    return { ...thread, sendRefusal, handoff, pendingActions };
  }

  async messages(userId: string, id: string, afterSeq: number, limit: number): Promise<{ items: ChatMessageRecord[] }> {
    const thread = await this.requireOwnedThread(userId, id);
    return { items: await this.threads.messages(thread.id, afterSeq, limit) };
  }

  /**
   * The cap PATCH answers a `WorkspaceThreadDto`, which carries the home project the cap row's own read does
   * not: the project is read with the thread before the write (the key check needs the row anyway) and joined
   * back into the updated record.
   */
  async updateCap(principal: UserPrincipal | AgentPrincipal, id: string, value: unknown): Promise<ChatThreadRecord & { homeProject: { slug: string; name: string } }> {
    if (!isMaxCostUsd(value)) throw new ValidationAppException({ reason: 'maxCostUsd' }, 'threads.input');
    const thread = await this.requireOwnedThread(principal.id, id);
    await this.assertThreadKey(principal, 'thread.cap.update', thread);
    const updated = await this.threads.updateCap({ kind: 'workspace', userId: principal.id }, id, principal.id, String(value));
    if (!thread.homeProject) throw new NotFoundAppException({}, 'projects');
    return { ...updated, homeProject: thread.homeProject };
  }

  async stop(principal: UserPrincipal | AgentPrincipal, threadId: string): Promise<void> {
    const thread = await this.requireOwnedThread(principal.id, threadId);
    await this.assertThreadKey(principal, 'thread.stop', thread);
    return this.threads.command({ kind: 'workspace', userId: principal.id }, threadId, principal.id, FleetCommandType.THREAD_STOP_TURN, {});
  }

  async endSession(principal: UserPrincipal | AgentPrincipal, threadId: string): Promise<void> {
    const thread = await this.requireOwnedThread(principal.id, threadId);
    await this.assertThreadKey(principal, 'thread.end-session', thread);
    return this.threads.command({ kind: 'workspace', userId: principal.id }, threadId, principal.id, FleetCommandType.THREAD_CLOSE, {});
  }

  async answer(principal: UserPrincipal | AgentPrincipal, threadId: string, input: AnswerQuestionDto): Promise<void> {
    if (typeof input.requestId !== 'string' || input.requestId.length < 1 || input.requestId.length > 128 || typeof input.text !== 'string' || input.text.length < 1 || Buffer.byteLength(input.text, 'utf8') > 32768) throw new ValidationAppException({ reason: 'answer' }, 'threads.input');
    const thread = await this.requireOwnedThread(principal.id, threadId);
    await this.assertThreadKey(principal, 'thread.answer', thread);
    return this.threads.command({ kind: 'workspace', userId: principal.id }, threadId, principal.id, FleetCommandType.THREAD_ANSWER, input);
  }

  async sendMessage(principal: UserPrincipal | AgentPrincipal, id: string, input: SendMessageDto): Promise<{ message: ChatMessageRecord; jobId: string | null; deduplicated: boolean }> {
    if (typeof input.text !== 'string' || input.text.length === 0 || Buffer.byteLength(input.text, 'utf8') > 32768 ||
        typeof input.clientMessageId !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(input.clientMessageId)) {
      throw new ValidationAppException({ reason: 'message' }, 'threads.input');
    }
    const thread = await this.requireOwnedThread(principal.id, id);
    // Like REPO context resolution, the live host check is deliberately outside the send transaction (1d-D9).
    // US-003: the home project's `thread.create` key decides, so a demoted creator cannot keep sending.
    const reachable = await this.projects.findAllForPrincipal(principal);
    if (!reachable.some(project => project.id === thread.projectId) || !await this.canHost(thread.projectId, principal)) {
      throw new ForbiddenAppException({}, 'permissions');
    }
    return this.threads.sendMessage({ scope: { kind: 'workspace', userId: principal.id }, threadId: id, userId: principal.id, text: input.text, clientMessageId: input.clientMessageId, repoContext: undefined });
  }

  async archive(principal: UserPrincipal | AgentPrincipal, id: string): Promise<void> {
    const thread = await this.requireOwnedThread(principal.id, id);
    const jobId = await this.threads.archive({ kind: 'workspace', userId: principal.id }, id, principal.id, false);
    if (!jobId) return;
    try { await this.fleetJobs.cancel(principal.id, thread.projectId, jobId, true); }
    catch (error) {
      if (!(error instanceof ConflictAppException)) throw error;
      // The terminal transition may win after archive commits.
    }
  }

  /**
   * The four keys that need the thread's own row (US-003): the check runs in the thread's home project with
   * the thread's creator as the resource, so an any-row holder acts on every thread of the project and a
   * `.own` holder only on its own. The refusal is the permissions code. No `canOperate` reaches the
   * repository: the workspace fence already limits every call to the caller's own thread.
   */
  private async assertThreadKey(principal: UserPrincipal | AgentPrincipal, key: string, thread: ChatThreadRecord): Promise<void> {
    const decision = await this.permissions.can(principal, key, {
      projectId: thread.projectId,
      resource: { createdBy: { type: thread.createdByType ?? 'USER', id: thread.createdById } },
    });
    if (!decision.allowed) throw new ForbiddenAppException({}, 'permissions');
  }

  /** Hosting a thread in a project is that project's `thread.create` key (replaces the CASL `CREATE FleetJob`). */
  private async canHost(projectId: string, principal: UserPrincipal | AgentPrincipal): Promise<boolean> {
    return (await this.permissions.can(principal, 'thread.create', { projectId })).allowed;
  }
}
