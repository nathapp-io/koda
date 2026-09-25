import { Injectable, Inject, Logger } from '@nestjs/common';
import { NotFoundAppException, ValidationAppException, ForbiddenAppException } from '@nathapp/nestjs-common';
import { ITransactionManager, TRANSACTION_MANAGER } from '@nathapp/nestjs-data';
import { CreateTicketDto } from './dto/create-ticket.dto';
import { UpdateTicketDto } from './dto/update-ticket.dto';
import { TicketResponseDto } from './dto/ticket-response.dto';
import { TicketType, TicketStatus, Priority } from '../common/enums';
import { buildGitUrl } from '../common/utils/git-url.util';
import { actorForeignKeys } from '../auth/principal/actor-foreign-keys';
import { isUserPrincipal, KodaPrincipal } from '../auth/principal/koda-principal.types';
import { TICKET_REPOSITORY, ITicketRepository } from './domain/ticket.domain';
import { TicketEventService } from '../events/ticket-event.service';
import { buildTicketEventOutboxPayload } from '../events/outbox-envelope.util';
import { OutboxService } from '../outbox/outbox.service';
import { TicketTransitionsService } from './state-machine/ticket-transitions.service';

interface FindAllFilters {
  status?: TicketStatus;
  type?: TicketType;
  priority?: Priority;
  assignedTo?: string;
  unassigned?: boolean;
  limit?: number;
  page?: number;
}

interface AssignInput {
  userId?: string;
  agentId?: string;
}

@Injectable()
export class TicketsService {
  private readonly logger = new Logger(TicketsService.name);

  constructor(
    @Inject(TICKET_REPOSITORY) private readonly ticketRepo: ITicketRepository,
    @Inject(TRANSACTION_MANAGER) private readonly txManager: ITransactionManager,
    private readonly ticketEventService: TicketEventService,
    private readonly outboxService: OutboxService,
    private readonly transitionsService: TicketTransitionsService,
  ) {}

  private async emitTicketEvent(
    ticketId: string,
    projectId: string,
    action: string,
    principal: KodaPrincipal,
    extra: Record<string, unknown> = {},
  ): Promise<void> {
    try {
      const actorType = isUserPrincipal(principal) ? 'user' : 'agent';
      const event = await this.ticketEventService.create({
        ticketId,
        projectId,
        action,
        actorId: principal.id,
        actorType,
        source: 'internal',
        data: extra,
      });
      await this.outboxService.enqueue({
        projectId,
        eventType: 'ticket_event',
        eventId: event.id,
        // H13: consumers switch on action/id/timestamp — enqueue the full event envelope
        payload: buildTicketEventOutboxPayload({
          event,
          ticketId,
          projectId,
          actorId: principal.id,
          actorType,
          data: extra,
        }),
      });
    } catch (err) {
      this.logger.warn(
        `Non-fatal: failed to emit TicketEvent after ${action} on ticket ${ticketId}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
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

    /** @design @@unique([projectId, number]) in schema is the safety net against concurrent duplicate numbers; txManager.run() serializes on SQLite and the constraint errors on PostgreSQL so callers retry. */
    const ticket = await this.txManager.run(async () => {
      const lastTicket = await this.ticketRepo.findLastTicketInProject(project.id);
      const nextNumber = (lastTicket?.number ?? 0) + 1;

      const creatorKeys = actorForeignKeys(principal, 'createdBy');
      return this.ticketRepo.createTicket({
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
    });

    const response = TicketResponseDto.from({ ...ticket, ref: `${project.key}-${ticket.number}` }, project.key);

    void this.emitTicketEvent(ticket.id, project.id, 'TICKET_CREATED', principal, {
      type: ticket.type,
      title: ticket.title,
    });

    return response;
  }

  async findAll(projectSlug: string, filters: FindAllFilters) {
    const project = await this.ticketRepo.findProjectBySlug(projectSlug);

    if (!project || project.deletedAt) {
      throw new NotFoundAppException({}, 'tickets');
    }

    const limit = filters.limit || 20;
    const page = filters.page || 1;

    const repoFilters = {
      projectId: project.id,
      status: filters.status,
      type: filters.type,
      priority: filters.priority,
      assignedToUserId: filters.assignedTo,
      unassigned: filters.unassigned,
      limit,
      page,
    };

    const [tickets, total] = await Promise.all([
      this.ticketRepo.findTicketsByProject(repoFilters),
      this.ticketRepo.countTicketsByProject(repoFilters),
    ]);

    return {
      items: TicketResponseDto.fromMany(tickets, project.key).map((t, i) => {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const raw = tickets[i] as any;
        return {
          ...t,
          gitRefUrl: this.computeGitRefUrl(
            project.gitRemoteUrl,
            raw.gitRefVersion,
            raw.gitRefFile,
            raw.gitRefLine,
          ),
        };
      }),
      total,
      page,
      limit,
    };
  }

  async findByRef(projectSlug: string, ref: string) {
    const project = await this.ticketRepo.findProjectBySlug(projectSlug);

    if (!project || project.deletedAt) {
      throw new NotFoundAppException({}, 'tickets');
    }

    // H5: single scoped lookup — KEY-N prefix must match the project key and
    // CUIDs are constrained to this project; soft-deleted tickets miss.
    const ticket = await this.ticketRepo.findTicketScoped(project.id, project.key, ref);

    if (!ticket || ticket.deletedAt) {
      throw new NotFoundAppException({}, 'tickets');
    }

    const gitRefUrl = this.computeGitRefUrl(
      project.gitRemoteUrl,
      ticket.gitRefVersion,
      ticket.gitRefFile,
      ticket.gitRefLine,
    );
    return TicketResponseDto.from(ticket, project.key, gitRefUrl);
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
      // Final-review Finding B: verify TRANSITION permission BEFORE any field
      // write. A caller with UPDATE but no TRANSITION must get a clean 403,
      // not a partial field write followed by 403. executeTransitionPublic
      // re-runs the same check (defense in depth, no extra DB work).
      await this.transitionsService.assertTransitionPermission(principal);
      const { status, ...rest } = updateTicketDto;
      if (Object.keys(rest).length > 0) {
        // Apply field updates first, then transition; keep it one perceived operation
        await this.applyUpdate(projectSlug, ref, rest as UpdateTicketDto, principal);
      }
      const result = await this.transitionsService.executeTransitionPublic(projectSlug, ref, status, principal);
      return result.ticket;
    }

    return this.applyUpdate(projectSlug, ref, updateTicketDto, principal);
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

    const updateData: UpdateTicketDto = {};

    if (updateTicketDto.title !== undefined) {
      updateData.title = updateTicketDto.title;
    }
    if (updateTicketDto.description !== undefined) {
      updateData.description = updateTicketDto.description;
    }
    if (updateTicketDto.priority !== undefined) {
      updateData.priority = updateTicketDto.priority;
    }

    const updated = await this.ticketRepo.updateTicket(ticket.id, updateData);

    const project = await this.ticketRepo.findProjectBySlug(projectSlug);
    const gitRefUrl = this.computeGitRefUrl(
      project?.gitRemoteUrl,
      updated.gitRefVersion,
      updated.gitRefFile,
      updated.gitRefLine,
    );
    const response = TicketResponseDto.from(updated, project?.key, gitRefUrl);

    if (project?.id) {
      void this.emitTicketEvent(ticket.id, project.id, 'TICKET_UPDATED', principal, {
        ...updateData,
      });
    }

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

    const updated = await this.ticketRepo.softDeleteTicket(ticket.id);

    const project = await this.ticketRepo.findProjectBySlug(projectSlug);
    const gitRefUrl = this.computeGitRefUrl(
      project?.gitRemoteUrl,
      updated.gitRefVersion,
      updated.gitRefFile,
      updated.gitRefLine,
    );
    const response = TicketResponseDto.from(updated, project?.key, gitRefUrl);

    if (project?.id) {
      void this.emitTicketEvent(ticket.id, project.id, 'TICKET_DELETED', principal);
    }

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

    const ticket = await this.findByRef(projectSlug, ref);
    if (!ticket) {
      throw new NotFoundAppException({}, 'tickets');
    }

    // Existence + project membership checks so FK violations surface as 404/403
    // instead of a raw Prisma 500 (BUG-2).
    if (assignInput.userId) {
      const user = await this.ticketRepo.findUserById(assignInput.userId);
      if (!user) {
        throw new NotFoundAppException({}, 'tickets');
      }
      // BUG-17: ADMIN-role assignees are implicit members (mirrors
      // ProjectAccessService.assertProjectMembership's admin exemption).
      if (user.role !== 'ADMIN') {
        const role = await this.ticketRepo.findProjectMemberRole(project.id, assignInput.userId);
        if (!role) {
          throw new ForbiddenAppException({}, 'tickets');
        }
      }
    } else if (assignInput.agentId) {
      const agent = await this.ticketRepo.findAgentById(assignInput.agentId);
      if (!agent) {
        throw new NotFoundAppException({}, 'tickets');
      }
    }

    const assignData = {
      assignedToUserId: null as string | null,
      assignedToAgentId: null as string | null,
    };

    if (assignInput.userId) {
      assignData.assignedToUserId = assignInput.userId;
    } else if (assignInput.agentId) {
      assignData.assignedToAgentId = assignInput.agentId;
    }

    const updated = await this.ticketRepo.assignTicket(ticket.id, assignData);

    // H13: emit an 'assigned' ticket_event so memory extraction and entity-graph
    // updates run for assignment activity. Fire-and-forget; never fails the request.
    if (principal) {
      void this.emitTicketEvent(ticket.id, project.id, 'assigned', principal, {
        assignedTo: assignInput.userId ?? assignInput.agentId ?? null,
      });
    }

    const gitRefUrl = this.computeGitRefUrl(
      project.gitRemoteUrl,
      updated.gitRefVersion,
      updated.gitRefFile,
      updated.gitRefLine,
    );
    return TicketResponseDto.from(updated, project.key, gitRefUrl);
  }
}
