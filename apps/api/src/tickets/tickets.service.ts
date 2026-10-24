import { Injectable, Inject } from '@nestjs/common';
import { NotFoundAppException, ValidationAppException, ForbiddenAppException } from '@nathapp/nestjs-common';
import { ConflictAppException } from '../common/exceptions/conflict-app.exception';
import type { IPageOption } from '@nathapp/nestjs-common';
import type { IPageResult } from '@nathapp/nestjs-data';
import { ITransactionManager, TRANSACTION_MANAGER } from '@nathapp/nestjs-data';
import { CreateTicketDto } from './dto/create-ticket.dto';
import { UpdateTicketDto } from './dto/update-ticket.dto';
import { TicketResponseDto } from './dto/ticket-response.dto';
import { ListTicketsQuery } from './dto/list-tickets.query';
import { remapPage } from '../common/dto/koda-page.query';
import { TicketType, TicketStatus, Priority } from '../common/enums';
import { buildGitUrl } from '../common/utils/git-url.util';
import { actorForeignKeys } from '../auth/principal/actor-foreign-keys';
import { actorKind, KodaPrincipal } from '../auth/principal/koda-principal.types';
import { runWithTicketNumberRetry } from '../common/utils/ticket-number-retry';
import { TICKET_REPOSITORY, ITicketRepository, TicketDomain, AssignTicketData } from './domain/ticket.domain';
import { TicketEventService } from '../events/ticket-event.service';
import { buildTicketEventOutboxPayload } from '../events/outbox-envelope.util';
import { OutboxService as NathappOutboxService } from '@nathapp/nestjs-outbox';
import { TicketTransitionsService } from './state-machine/ticket-transitions.service';
import type { TransitionFieldPatch, TransitionTicketShape } from './state-machine/ticket-transitions.service';
import { PermissionService } from '../permissions/permission.service';
import { allowedActions, TICKET_ACTIONS } from './state-machine/allowed-actions';
import type { TicketAction } from './state-machine/allowed-actions';
import { TICKET_ACTION_KEYS } from './state-machine/transition-keys';
import { TicketDetailResponseDto } from './dto/ticket-detail-response.dto';
import { AuditRecorder } from '../audit/audit-recorder.service';
import { fieldsSummary } from '../audit/audit-summary';

/**
 * The list filters of `findAll`. `titleContains` is not on the REST `ListTicketsQuery` (S5b US-003): only the
 * agent-facing koda search passes it.
 */
export type TicketListFilterInput = Omit<ListTicketsQuery, 'current' | 'size'> & {
  assignedToAgentId?: string;
  titleContains?: string;
};

interface AssignInput {
  userId?: string;
  agentId?: string;
}

@Injectable()
export class TicketsService {
  constructor(
    @Inject(TICKET_REPOSITORY) private readonly ticketRepo: ITicketRepository,
    @Inject(TRANSACTION_MANAGER) private readonly txManager: ITransactionManager,
    private readonly ticketEventService: TicketEventService,
    private readonly outbox: NathappOutboxService,
    private readonly transitionsService: TicketTransitionsService,
    // Permissions P1 (US-004): the one decision point for the detail view's `allowedActions`. Required:
    // a route that cannot name the caller's keys must not answer an empty or guessed action list.
    private readonly permissions: PermissionService,
    private readonly audit: AuditRecorder,
  ) {}

  /**
   * Writes the TicketEvent row and its ticket_event outbox row. Must be called
   * inside the business write's txManager.run so all three commit or roll back
   * together (outside run() the outbox row would commit on its own).
   */
  private async recordTicketEvent(
    ticketId: string,
    projectId: string,
    action: string,
    principal: KodaPrincipal,
    extra: Record<string, unknown> = {},
  ): Promise<void> {
    const actorType = actorKind(principal);
    const event = await this.ticketEventService.create({
      ticketId,
      projectId,
      action,
      actorId: principal.id,
      actorType,
      source: 'internal',
      data: extra,
    });
    await this.outbox.record({
      type: 'ticket_event',
      // H13: consumers switch on action/id/timestamp — record the full event envelope
      payload: buildTicketEventOutboxPayload({ event, ticketId, projectId, actorId: principal.id, actorType, data: extra }),
      metadata: { projectId, eventId: event.id },
    });
  }

  private computeGitRefUrl(
    gitRemoteUrl: string | null | undefined,
    gitRefVersion: string | null | undefined,
    gitRefFile: string | null | undefined,
    gitRefLine: number | null | undefined,
  ): string | null {
    if (!gitRefFile) return null;
    return buildGitUrl(gitRemoteUrl, gitRefVersion ?? 'main', gitRefFile, gitRefLine ?? undefined);
  }

  async create(
    projectSlug: string,
    createTicketDto: CreateTicketDto,
    principal: KodaPrincipal,
  ) {
    const project = await this.ticketRepo.findProjectBySlug(projectSlug);

    if (!project || project.deletedAt) {
      throw new NotFoundAppException({}, 'tickets');
    }

    if (createTicketDto.type === undefined) {
      throw new ValidationAppException({}, 'tickets');
    }
    if (createTicketDto.title === undefined) {
      throw new ValidationAppException({}, 'tickets');
    }
    if (typeof createTicketDto.title === 'string' && createTicketDto.title.trim().length === 0) {
      throw new ValidationAppException({}, 'tickets');
    }

    // @@unique([projectId, number]) rejects concurrent duplicate numbers on
    // Postgres; runWithTicketNumberRetry re-runs the whole transaction (M6).
    const ticket = await runWithTicketNumberRetry(this.txManager, async () => {
      const lastTicket = await this.ticketRepo.findLastTicketInProject(project.id);
      const nextNumber = (lastTicket?.number ?? 0) + 1;

      const creatorKeys = actorForeignKeys(principal, 'createdBy');
      const created = await this.ticketRepo.createTicket({
        projectId: project.id,
        number: nextNumber,
        type: createTicketDto.type,
        title: createTicketDto.title,
        description: createTicketDto.description || null,
        status: TicketStatus.CREATED,
        priority: createTicketDto.priority || Priority.MEDIUM,
        createdByUserId: creatorKeys.createdByUserId,
        createdByAgentId: creatorKeys.createdByAgentId,
      });
      await this.recordTicketEvent(created.id, project.id, 'TICKET_CREATED', principal, {
        type: created.type,
        title: created.title,
      });
      await this.audit.record({
        key: 'ticket.create', resourceType: 'ticket', resourceId: created.id,
        projectId: project.id, summary: `created ${project.key}-${created.number}`,
      });
      return created;
    });

    const response = TicketResponseDto.from({ ...ticket, ref: `${project.key}-${ticket.number}` }, project.key);

    return response;
  }

  async findAll(
    projectSlug: string,
    filters: TicketListFilterInput,
    page: IPageOption,
  ): Promise<IPageResult<TicketResponseDto>> {
    const project = await this.ticketRepo.findProjectBySlug(projectSlug);

    if (!project || project.deletedAt) {
      throw new NotFoundAppException({}, 'tickets');
    }

    const tickets = await this.ticketRepo.findTicketPage(
      {
        projectId: project.id,
        status: filters.status,
        type: filters.type,
        priority: filters.priority,
        assignedToUserId: filters.assignedTo,
        assignedToAgentId: filters.assignedToAgentId,
        unassigned: filters.unassigned,
        titleContains: filters.titleContains,
      },
      page,
    );

    return remapPage(tickets, (ticket: TicketDomain) =>
      TicketResponseDto.from(
        ticket,
        project.key,
        this.computeGitRefUrl(project.gitRemoteUrl, ticket.gitRefVersion, ticket.gitRefFile, ticket.gitRefLine),
      ),
    );
  }

  async findByRef(projectSlug: string, ref: string) {
    const { project, ticket } = await this.loadTicket(projectSlug, ref);
    return TicketResponseDto.from(
      ticket,
      project.key,
      this.computeGitRefUrl(project.gitRemoteUrl, ticket.gitRefVersion, ticket.gitRefFile, ticket.gitRefLine),
    );
  }

  /**
   * The project and the ticket one ref names, with the two 404s.
   *
   * H5: a single scoped lookup — the KEY-N prefix must match the project key and CUIDs are constrained
   * to this project; soft-deleted tickets miss. The project row comes back with the ticket because the
   * detail view needs `project.id` for the caller's keys as well as `project.key` for the ref.
   */
  private async loadTicket(projectSlug: string, ref: string) {
    const project = await this.ticketRepo.findProjectBySlug(projectSlug);

    if (!project || project.deletedAt) {
      throw new NotFoundAppException({}, 'tickets');
    }

    const ticket = await this.ticketRepo.findTicketScoped(project.id, project.key, ref);

    if (!ticket || ticket.deletedAt) {
      throw new NotFoundAppException({}, 'tickets');
    }

    return { project, ticket };
  }

  /**
   * S5b US-005: ticket id -> ref (`KEY-N`) for the named ids, in one read. `projectId` is the whole
   * scope, so an id of another project (or of a soft-deleted ticket) is absent from the map instead of
   * resolved — a caller can never name a ticket of a project it is not acting in.
   */
  async findRefsByIds(projectId: string, ids: string[]): Promise<Map<string, string>> {
    if (ids.length === 0) return new Map();
    const refs = await this.ticketRepo.findTicketRefs(projectId, ids);
    return new Map(refs.map((row) => [row.id, row.ref]));
  }

  /**
   * M25: the detail view plus the actions the caller may take. `principal` is the caller's own principal
   * (permissions P1 US-004: the controller no longer decorates it with a project role).
   *
   * Permissions P1 (US-004): the actions come from the caller's keys in this project, not from the
   * legacy CASL ability — an action is offered when the caller holds at least one of the keys
   * `TICKET_ACTION_KEYS` names for it (`verify-fix` names both outcomes) and the state machine allows
   * it from the ticket's current status.
   */
  async findByRefWithActions(projectSlug: string, ref: string, principal: KodaPrincipal): Promise<TicketDetailResponseDto> {
    const { project, ticket } = await this.loadTicket(projectSlug, ref);
    const base = TicketResponseDto.from(
      ticket,
      project.key,
      this.computeGitRefUrl(project.gitRemoteUrl, ticket.gitRefVersion, ticket.gitRefFile, ticket.gitRefLine),
    );
    const permitted = await this.permittedActions(project.id, principal);
    return { ...base, allowedActions: allowedActions(ticket.status as TicketStatus, permitted) };
  }

  /** The actions the caller holds one of the keys for in `projectId`, in `TICKET_ACTIONS` order. */
  private async permittedActions(
    projectId: string,
    principal: KodaPrincipal,
  ): Promise<ReadonlySet<TicketAction>> {
    const decisions = await Promise.all(
      TICKET_ACTIONS.map(async (action): Promise<TicketAction | undefined> => {
        const keys = TICKET_ACTION_KEYS[action];
        const results = await Promise.all(
          keys.map((key) => this.permissions.can(principal, key, { projectId })),
        );
        return results.some((decision) => decision.allowed) ? action : undefined;
      }),
    );
    return new Set(decisions.filter((action): action is TicketAction => action !== undefined));
  }

  async update(
    projectSlug: string,
    ref: string,
    updateTicketDto: UpdateTicketDto,
    principal: KodaPrincipal,
  ) {
    // M2: status changes are routed through the transition state machine
    // (TRANSITION validation + activity row + webhook) instead of a direct
    // write that bypassed them. Other fields keep the direct update path.
    if (updateTicketDto.status !== undefined) {
      // Permissions P1 (US-003): the edge key of the requested change is checked
      // BEFORE any field write. A caller with ticket.update but not the edge key
      // (ticket.transition.start for CREATED -> IN_PROGRESS) must get a clean 403,
      // not a partial field write followed by 403. The transition itself checks the
      // same edge again inside executeTransitionInternal.
      await this.transitionsService.assertTransitionAllowed(
        projectSlug,
        ref,
        updateTicketDto.status,
        principal,
      );
      const { status, ...rest } = updateTicketDto;
      // Whole-branch fix B3: the field writes travel with the transition instead of committing in a
      // transaction of their own. Both the edge check and the conditional status write now run before
      // them, so a refusal — the pre-check here, the edge re-check on the ticket's *live* status, or a
      // 409 from a lost race — leaves no field written, and the fields commit only with the status.
      const fields = Object.keys(rest).length > 0 ? this.fieldPatch(rest, principal) : undefined;
      const result = await this.transitionsService.executeTransitionPublic(
        projectSlug,
        ref,
        status,
        principal,
        fields,
      );
      return result.ticket;
    }

    return this.applyUpdate(projectSlug, ref, updateTicketDto, principal);
  }

  /**
   * The field writes of a `PATCH …?status=` as the patch the transition applies inside its transaction.
   * `previous` is the row the transition loaded, so the TICKET_UPDATED event still carries the earlier
   * description the mention resolver diffs against.
   */
  private fieldPatch(rest: UpdateTicketDto, principal: KodaPrincipal): TransitionFieldPatch {
    const updateData = TicketsService.toUpdateData(rest);
    return async ({ ticketId, projectId, previous }) => {
      const row = await this.ticketRepo.updateTicket(ticketId, updateData);
      const summary = fieldsSummary(updateData);
      if (summary !== undefined) {
        await this.audit.record({
          key: 'ticket.update', resourceType: 'ticket', resourceId: ticketId,
          projectId, summary,
        });
      }
      const previousDescription = (previous as { description?: string | null }).description ?? null;
      await this.recordTicketEvent(
        ticketId,
        projectId,
        'TICKET_UPDATED',
        principal,
        updateData.description !== undefined
          ? { ...updateData, previousDescription }
          : { ...updateData },
      );
      return row as unknown as TransitionTicketShape;
    };
  }

  /** The writable columns of a PATCH body; `status` is never one of them (the transitions own it). */
  private static toUpdateData(dto: UpdateTicketDto): UpdateTicketDto {
    const updateData: UpdateTicketDto = {};
    if (dto.title !== undefined) {
      updateData.title = dto.title;
    }
    if (dto.description !== undefined) {
      updateData.description = dto.description;
    }
    if (dto.priority !== undefined) {
      updateData.priority = dto.priority;
    }
    return updateData;
  }

  /**
   * Direct field update path (no status handling — status goes through the
   * transitions service). Enforces ticket existence; UPDATE permission is
   * enforced at the controller (CASL) layer.
   */
  private async applyUpdate(
    projectSlug: string,
    ref: string,
    updateTicketDto: UpdateTicketDto,
    principal: KodaPrincipal,
  ) {
    const ticket = await this.findByRef(projectSlug, ref);
    if (!ticket) {
      throw new NotFoundAppException({}, 'tickets');
    }

    const updateData = TicketsService.toUpdateData(updateTicketDto);
    const project = await this.ticketRepo.findProjectBySlug(projectSlug);

    const updated = await this.txManager.run(async () => {
      const row = await this.ticketRepo.updateTicket(ticket.id, updateData);
      if (project?.id) {
        // S4a §2.2: mention notifications diff the new description against the previous one.
        const eventData = updateData.description !== undefined
          ? { ...updateData, previousDescription: ticket.description ?? null }
          : { ...updateData };
        await this.recordTicketEvent(ticket.id, project.id, 'TICKET_UPDATED', principal, eventData);
        const summary = fieldsSummary(updateData);
        if (summary !== undefined) {
          await this.audit.record({
            key: 'ticket.update', resourceType: 'ticket', resourceId: ticket.id,
            projectId: project.id, summary,
          });
        }
      }
      return row;
    });

    const gitRefUrl = this.computeGitRefUrl(
      project?.gitRemoteUrl,
      updated.gitRefVersion,
      updated.gitRefFile,
      updated.gitRefLine,
    );
    const response = TicketResponseDto.from(updated, project?.key, gitRefUrl);

    return response;
  }

  async softDelete(
    projectSlug: string,
    ref: string,
    principal: KodaPrincipal,
  ) {
    const ticket = await this.findByRef(projectSlug, ref);
    if (!ticket) {
      throw new NotFoundAppException({}, 'tickets');
    }

    const project = await this.ticketRepo.findProjectBySlug(projectSlug);

    const updated = await this.txManager.run(async () => {
      const row = await this.ticketRepo.softDeleteTicket(ticket.id);
      if (project?.id) {
        await this.recordTicketEvent(ticket.id, project.id, 'TICKET_DELETED', principal);
        await this.audit.record({
          key: 'ticket.delete', resourceType: 'ticket', resourceId: ticket.id,
          projectId: project.id, summary: `deleted ${project.key}-${ticket.number}`,
        });
      }
      return row;
    });

    const gitRefUrl = this.computeGitRefUrl(
      project?.gitRemoteUrl,
      updated.gitRefVersion,
      updated.gitRefFile,
      updated.gitRefLine,
    );
    const response = TicketResponseDto.from(updated, project?.key, gitRefUrl);

    return response;
  }

  async assign(projectSlug: string, ref: string, assignInput: AssignInput, principal?: KodaPrincipal) {
    if (assignInput.userId && assignInput.agentId) {
      throw new ValidationAppException({}, 'tickets');
    }

    const project = await this.ticketRepo.findProjectBySlug(projectSlug);

    if (!project || project.deletedAt) {
      throw new NotFoundAppException({}, 'tickets');
    }

    // S4c US-004: the ticket lookup, the assignee lookups, the eligibility
    // checks and the write share one transaction. The agent path takes the
    // project's roster lock before reading the roster, the same lock an
    // agent-binding removal takes (`MembershipService.removeBinding`, US-002),
    // so a concurrent removal and assignment serialize and a ticket can never
    // end up assigned to an agent that just lost its last binding in the
    // project. Assignment eligibility is checked independently
    // of the calling agent's project access.
    const updated = await this.txManager.run(async () => {
      const ticket = await this.ticketRepo.findTicketScoped(project.id, project.key, ref);
      if (!ticket || ticket.deletedAt) {
        throw new NotFoundAppException({}, 'tickets');
      }

      const assignData: AssignTicketData = {
        assignedToUserId: null,
        assignedToAgentId: null,
      };

      if (assignInput.userId) {
        const user = await this.ticketRepo.findUserById(assignInput.userId);
        if (!user) {
          throw new NotFoundAppException({}, 'tickets');
        }
        // A disabled account cannot act on the project, so it is never an
        // assignee. Best-effort against a concurrent disable: the read happens
        // inside this transaction but takes no lock on the user row.
        if (user.disabled) {
          throw new ConflictAppException({}, 'tickets.userDisabled');
        }
        // Permissions P1 (US-002): an assignee is eligible when it holds `project.read` in the
        // project — a custom project role narrows and widens it, the user row's `role` claim does not
        // decide. The read is the assignee's, in the project's scope, not the caller's.
        const assigneeKeys = await this.permissions.effectiveKeys(
          { type: 'USER', id: user.id },
          { projectId: project.id },
        );
        if (!assigneeKeys.has('project.read')) {
          throw new ForbiddenAppException({}, 'tickets');
        }
        assignData.assignedToUserId = user.id;
      } else if (assignInput.agentId) {
        await this.ticketRepo.lockProjectAgents(project.id);
        const agent = await this.ticketRepo.findAgentById(assignInput.agentId);
        if (!agent) {
          throw new NotFoundAppException({}, 'tickets');
        }
        // Roster before status: an unrostered OFFLINE agent is refused as
        // not-in-project (the roster is the gate, the status the second rule).
        if (!(await this.ticketRepo.isAgentOnProjectRoster(project.id, agent.id))) {
          throw new ConflictAppException({}, 'tickets.agentNotInProject');
        }
        // An OFFLINE agent cannot authenticate, so it cannot work the ticket.
        if (agent.status === 'OFFLINE') {
          throw new ConflictAppException({}, 'tickets.agentOffline');
        }
        assignData.assignedToAgentId = agent.id;
      }

      // H13: record an 'assigned' ticket_event so memory extraction and entity-graph
      // updates run for assignment activity.
      const row = await this.ticketRepo.assignTicket(ticket.id, assignData);
      if (principal) {
        await this.recordTicketEvent(ticket.id, project.id, 'assigned', principal, {
          assignedTo: assignInput.userId ?? assignInput.agentId ?? null,
          // S4a §2.2: the notification producer must not guess whether the id is a user or an agent.
          assigneeType: assignInput.userId ? 'user' : assignInput.agentId ? 'agent' : null,
        });
      }
      const assigneeSummary = assignInput.userId
        ? `assignee: USER ${assignInput.userId}`
        : assignInput.agentId
          ? `assignee: AGENT ${assignInput.agentId}`
          : 'assignee: none';
      await this.audit.record({
        key: 'ticket.assign', resourceType: 'ticket', resourceId: ticket.id,
        projectId: project.id, summary: assigneeSummary,
      });
      return row;
    });

    const gitRefUrl = this.computeGitRefUrl(
      project.gitRemoteUrl,
      updated.gitRefVersion,
      updated.gitRefFile,
      updated.gitRefLine,
    );
    return TicketResponseDto.from(updated, project.key, gitRefUrl);
  }
}
