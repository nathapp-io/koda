import { Injectable, Optional, Inject } from '@nestjs/common';
import { IsString, IsArray, IsIn } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';
import { NotFoundAppException, ValidationAppException, ForbiddenAppException } from '@nathapp/nestjs-common';
import { ITransactionManager, TRANSACTION_MANAGER } from '@nathapp/nestjs-data';
import { createHmac, randomBytes } from 'crypto';
import { AGENT_ROLES, type AgentRoleNames } from '../common/enums';
import { AgentResponseDto, AgentMeResponseDto, ProjectAgentDto, ProjectAgentListDto } from './dto/agent-response.dto';
import { TicketResponseDto } from '../tickets/dto/ticket-response.dto';
import { KodaPrincipal } from '../auth/principal/koda-principal.types';
import { KodaDomainWriter } from '../koda-domain-writer/koda-domain-writer.service';
import { AgentAuthProvider } from '../auth/agent-auth.provider';
import { PrismaAgentRepository } from './prisma-agent.repository';
import { AUTH_CFG, IAuthConfig } from '../config/auth.config';
import { ConflictAppException } from '../common/exceptions/conflict-app.exception';
import { isUniqueViolation } from '../common/utils/prisma-errors';
import { CreateAgentDto } from './dto/create-agent.dto';
import { UpdateAgentDto } from './dto/update-agent.dto';

export class UpdateRolesDto {
  @ApiProperty({ example: ['DEVELOPER', 'REVIEWER'] })
  @IsArray()
  @IsString({ each: true })
  @IsIn([...AGENT_ROLES], { each: true })
  roles!: string[];
}

export class UpdateCapabilitiesDto {
  @ApiProperty({ example: ['typescript', 'nestjs'] })
  @IsArray()
  @IsString({ each: true })
  capabilities!: string[];
}

@Injectable()
export class AgentsService {
  constructor(
    private readonly agentRepo: PrismaAgentRepository,
    @Inject(AUTH_CFG) private readonly authConfig: IAuthConfig,
    @Inject(TRANSACTION_MANAGER) private readonly txManager: ITransactionManager,
    @Optional() private readonly kodaDomainWriter?: KodaDomainWriter,
    @Optional() private readonly agentAuthProvider?: AgentAuthProvider,
  ) {}

  private static assertAgentRole(role: string): AgentRoleNames {
    if (!(AGENT_ROLES as readonly string[]).includes(role)) {
      throw new ValidationAppException({}, 'agents');
    }
    return role as AgentRoleNames;
  }

  private static validateAgentRoles(roles: readonly string[] | undefined): AgentRoleNames[] {
    return roles?.map((role) => AgentsService.assertAgentRole(role)) ?? [];
  }

  /**
   * Records an agent action event through the KodaDomainWriter write gateway.
   * No-op when KodaDomainWriter is not available (e.g., in isolated unit tests)
   * or when projectId is absent (agent-management operations have no project scope).
   */
  async recordAgentAction(
    agentId: string,
    action: string,
    data: Record<string, unknown> = {},
    projectId?: string,
  ): Promise<void> {
    if (!this.kodaDomainWriter || !projectId) return;
    await this.kodaDomainWriter.writeAgentAction({
      agentId,
      projectId,
      action,
      actorId: agentId,
      source: 'internal',
      data,
    });
  }


  async generateApiKey(agentId: string): Promise<{ apiKey: string; agent: AgentResponseDto }>;
  async generateApiKey(dto: CreateAgentDto): Promise<{ apiKey: string; agent: AgentResponseDto }>;
  async generateApiKey(agentIdOrDto: string | CreateAgentDto) {
    // Generate random 32-byte hex key
    const rawKey = randomBytes(32).toString('hex');

    // Compute HMAC-SHA256 hash with API_KEY_SECRET
    const apiKeySecret = this.authConfig.apiKeySecret;
    if (!apiKeySecret) {
      throw new ValidationAppException();
    }

    const apiKeyHash = createHmac('sha256', apiKeySecret).update(rawKey).digest('hex');

    if (typeof agentIdOrDto === 'string') {
      // Update existing agent
      const agent = await this.agentRepo.updateApiKeyHash(agentIdOrDto, apiKeyHash);
      await this.agentAuthProvider?.invalidateByTag(`AGENT:${agent.id}`);
      await this.recordAgentAction(agent.id, 'API_KEY_ROTATED', { agentId: agent.id });
      return {
        apiKey: rawKey,
        agent: AgentResponseDto.from(agent),
      };
    } else {
      // US-003: whitelist the agent row's scalar columns only — anything the
      // client stuffs into the request body (status, id, …) is dropped here.
      // maxConcurrentTickets is intentionally omitted when undefined so the
      // schema default applies.
      const { roles, capabilities, ...scalarFields } = agentIdOrDto;
      const validatedRoles = AgentsService.validateAgentRoles(roles);
      // CreateAgentDto requires a non-empty, pattern-checked slug (#145).
      const { slug } = scalarFields;
      const createData = {
        name: scalarFields.name,
        slug,
        apiKeyHash,
        ...(scalarFields.maxConcurrentTickets !== undefined
          ? { maxConcurrentTickets: scalarFields.maxConcurrentTickets }
          : {}),
      };

      // US-003: wrap the agent row, role and capability writes in a single
      // `txManager.run` callback. A failed role/capability write rejects out of
      // the callback and the transaction manager rolls back the agent row.
      const result = await this.txManager.run(async () => {
        const agent = await this.agentRepo.create(createData).catch((error: unknown) => {
          if (isUniqueViolation(error, 'slug')) {
            throw new ConflictAppException({}, 'agents');
          }
          throw error;
        });
        await this.agentRepo.createRolesAndCapabilities(agent.id, validatedRoles, capabilities ?? []);
        return agent;
      });
      await this.agentAuthProvider?.invalidateByTag(`AGENT:${result.id}`);
      const agentWithRelations = {
        ...result,
        roles: validatedRoles.map((role, index) => ({
          id: `generated-role-${index}`,
          agentId: result.id,
          role,
        })),
        capabilities: (capabilities ?? []).map((capability, index) => ({
          id: `generated-capability-${index}`,
          agentId: result.id,
          capability,
        })),
      };
      await this.recordAgentAction(result.id, 'AGENT_CREATED', { name: result.name, slug: result.slug });
      // Return raw key ONCE to client (never return the hash)
      return {
        apiKey: rawKey,
        agent: AgentResponseDto.from(agentWithRelations),
      };
    }
  }

  async findAll(): Promise<AgentResponseDto[]> {
    return AgentResponseDto.fromMany(await this.agentRepo.findAll());
  }

  async findBySlug(slug: string): Promise<AgentResponseDto> {
    const agent = await this.agentRepo.findBySlug(slug);

    if (!agent) {
      throw new NotFoundAppException({}, 'agents');
    }

    return AgentResponseDto.from(agent);
  }

  async findMe(agentId: string): Promise<AgentMeResponseDto> {
    const agent = await this.agentRepo.findById(agentId);

    if (!agent) {
      throw new NotFoundAppException({}, 'agents');
    }

    return AgentMeResponseDto.fromMe(agent, await this.agentRepo.findRosterProjects(agentId));
  }

  async findByProject(projectSlug: string): Promise<AgentResponseDto[]> {
    const result = await this.agentRepo.findByProjectSlug(projectSlug);
    if (!result) throw new NotFoundAppException({}, 'projects');
    return AgentResponseDto.fromMany(result.agents);
  }

  /**
   * US-002 (D530): the project's explicit agent roster. Reads the AgentProject
   * table — rostered agents without tickets appear; ticket holders without a
   * roster row do not. Throws 404 when the project is missing or soft-deleted
   * so callers can surface a stable error without guessing from an empty list.
   *
   * `scoping` reflects `AGENT_PROJECT_SCOPING` — the same flag the
   * ProjectAccessService reads to gate agent reach. Off = the response carries
   * `scoping: false`; the caller still gets the rostered list (post-001
   * state, just without the gate).
   */
  async listProjectRoster(projectSlug: string): Promise<ProjectAgentListDto> {
    const project = await this.agentRepo.findProjectBySlug(projectSlug);
    if (!project || project.deletedAt) {
      throw new NotFoundAppException({}, 'projects');
    }

    const records = await this.agentRepo.findProjectRoster(project.id);
    return ProjectAgentListDto.from(records, this.agentScopingEnabled());
  }

  /**
   * S4c US-003 (D530): put an agent on a project's roster. The caller's right to
   * do so is checked at the boundary (project ADMIN or global ADMIN); this only
   * knows the roster rules: the project and the agent must exist, an OFFLINE
   * agent cannot be added (it could not authenticate anyway), and the row is
   * keyed on (agent, project) so a duplicate add is a conflict.
   *
   * The insert and the re-read run under the same per-project roster lock
   * `removeFromProject` takes, so a concurrent add/remove of the same agent
   * serializes: a removal can no longer delete the row between the insert and
   * the re-read, which would have reported 404 for a row that was just created.
   *
   * Returns the roster row as the list serves it, so POST and GET agree on the
   * shape the CLI and the web read.
   */
  async addToProject(projectSlug: string, agentSlug: string, addedById: string): Promise<ProjectAgentDto> {
    const project = await this.agentRepo.findProjectBySlug(projectSlug);
    if (!project || project.deletedAt) throw new NotFoundAppException({}, 'projects');

    const agent = await this.agentRepo.findBySlugScalar(agentSlug);
    if (!agent) throw new NotFoundAppException({}, 'agents');
    if (agent.status === 'OFFLINE') throw new ConflictAppException({}, 'projectAgents.agentOffline');

    const record = await this.txManager.run(async () => {
      await this.agentRepo.lockProjectAgents(project.id);

      const added = await this.agentRepo.addToProjectRoster(agent.id, project.id, addedById);
      if (added === 'alreadyAssigned') throw new ConflictAppException({}, 'projectAgents.alreadyAssigned');

      return (await this.agentRepo.findProjectRoster(project.id)).find((row) => row.slug === agent.slug) ?? null;
    });

    if (!record) throw new NotFoundAppException({}, 'projectAgents');
    return ProjectAgentDto.from(record);
  }

  /**
   * S4c US-003 (D530/D531): take an agent off a project's roster. Removal is
   * refused while the agent still holds open tickets in that project, and the
   * whole read-then-write runs under the project's roster lock so a concurrent
   * assignment cannot slip an open ticket in between the count and the delete
   * (US-004 takes the same lock from the assignment side).
   */
  async removeFromProject(projectSlug: string, agentSlug: string): Promise<void> {
    const project = await this.agentRepo.findProjectBySlug(projectSlug);
    if (!project || project.deletedAt) throw new NotFoundAppException({}, 'projects');

    const agent = await this.agentRepo.findBySlugScalar(agentSlug);
    if (!agent) throw new NotFoundAppException({}, 'projectAgents');

    await this.txManager.run(async () => {
      await this.agentRepo.lockProjectAgents(project.id);

      if (!(await this.agentRepo.isOnProjectRoster(agent.id, project.id))) {
        throw new NotFoundAppException({}, 'projectAgents');
      }

      const open = await this.agentRepo.countOpenProjectTickets(agent.id, project.id);
      if (open.count > 0) {
        throw new ConflictAppException(
          { count: open.count, refs: open.refs.join(',') },
          'projectAgents.hasOpenTickets',
        );
      }

      await this.agentRepo.removeFromProjectRoster(agent.id, project.id);
    });
  }

  async update(slug: string, updateData: UpdateAgentDto): Promise<AgentResponseDto> {
    const existing = await this.agentRepo.findBySlugScalar(slug);
    if (!existing) throw new NotFoundAppException({}, 'agents');

    const data: Partial<{ name: string; status: string; maxConcurrentTickets: number }> = {};
    if (updateData.name !== undefined) data.name = updateData.name;
    if (updateData.maxConcurrentTickets !== undefined) data.maxConcurrentTickets = updateData.maxConcurrentTickets;
    if (updateData.status !== undefined) data.status = updateData.status;

    const updated = await this.agentRepo.update(slug, data);
    await this.agentAuthProvider?.invalidateByTag(`AGENT:${updated.id}`);
    return AgentResponseDto.from(updated);
  }

  async updateRoles(agentId: string, updateData: UpdateRolesDto): Promise<AgentResponseDto> {
    const validatedRoles = AgentsService.validateAgentRoles(updateData.roles);

    await this.agentRepo.replaceRoles(agentId, validatedRoles);

    // Return updated agent with roles
    const updated = await this.agentRepo.findById(agentId);
    await this.agentAuthProvider?.invalidateByTag(`AGENT:${agentId}`);
    return AgentResponseDto.from(updated);
  }

  async updateCapabilities(agentId: string, updateData: UpdateCapabilitiesDto): Promise<AgentResponseDto> {
    // Filter out duplicates
    const uniqueCapabilities = [...new Set(updateData.capabilities)];
    await this.agentRepo.replaceCapabilities(agentId, uniqueCapabilities);

    // Return updated agent with capabilities
    const updated = await this.agentRepo.findById(agentId);
    await this.agentAuthProvider?.invalidateByTag(`AGENT:${agentId}`);
    return AgentResponseDto.from(updated);
  }

  async remove(slug: string): Promise<AgentResponseDto> {
    const agent = await this.agentRepo.findBySlug(slug);
    if (!agent) throw new NotFoundAppException({}, 'agents');

    await this.agentRepo.deleteBySlug(slug);
    await this.agentAuthProvider?.invalidateByTag(`AGENT:${agent.id}`);
    return AgentResponseDto.from(agent);
  }

  private static readonly PRIORITY_RANK: Record<string, number> = {
    CRITICAL: 4,
    HIGH: 3,
    MEDIUM: 2,
    LOW: 1,
  };

  /**
   * S4c US-001 (D528): an absent flag means scoping is on. Only an explicit
   * `agentProjectScoping: false` restores the pre-S4c agent reach.
   */
  agentScopingEnabled(): boolean {
    return this.authConfig.agentProjectScoping !== false;
  }

  /**
   * US-003: ticket pickup is gated to the agent itself, or to a global ADMIN
   * user. 403 for everyone else; 404 when the project is missing or soft-deleted.
   *
   * S4c US-001: while project scoping is on, the target agent must also be on
   * the project's roster — a pickup is an act inside that project.
   */
  async suggestTicket(
    agentSlug: string,
    projectSlug: string,
    principal: KodaPrincipal,
  ) {
    // Authorize: only the matching agent or a global ADMIN user may pick up.
    const isOwningAgent = principal.actorType === 'agent' && principal.slug === agentSlug;
    const isGlobalAdmin = principal.actorType === 'user' && principal.role === 'ADMIN';
    if (!isOwningAgent && !isGlobalAdmin) {
      throw new ForbiddenAppException({}, 'agents');
    }

    const agent = await this.agentRepo.findBySlugWithCapabilities(agentSlug);
    if (!agent) throw new NotFoundAppException({}, 'agents');

    const project = await this.agentRepo.findProjectBySlug(projectSlug);
    // Soft-deleted projects 404 alongside missing ones — hides the project's
    // existence from agents that should not see it.
    if (!project || project.deletedAt) {
      throw new NotFoundAppException({}, 'agents');
    }

    if (this.agentScopingEnabled() && !(await this.agentRepo.isOnProjectRoster(agent.id, project.id))) {
      throw new ForbiddenAppException({}, 'agents');
    }

    const tickets = await this.agentRepo.findVerifiedUnassignedTickets(project.id);

    if (tickets.length === 0) return null;

    const capabilityNames: string[] = agent.capabilities.map(c => c.capability);
    const scored = tickets.map((ticket) => {
      const labelNames: string[] = (ticket.labels ?? []).map((tl: { label?: { name?: string } }) => tl.label?.name ?? '');
      const matched = capabilityNames.filter((cap) => labelNames.includes(cap));
      return {
        ticket: TicketResponseDto.from(ticket, project.key),
        matchScore: matched.length,
        matchedCapabilities: matched,
      };
    });

    scored.sort((a, b) => {
      if (b.matchScore !== a.matchScore) return b.matchScore - a.matchScore;
      const rankA = AgentsService.PRIORITY_RANK[a.ticket.priority] ?? 0;
      const rankB = AgentsService.PRIORITY_RANK[b.ticket.priority] ?? 0;
      return rankB - rankA;
    });

    await this.recordAgentAction(
      agent.id,
      'TICKET_SUGGESTED',
      { ticketId: scored[0].ticket.id, ticketNumber: scored[0].ticket.number },
      project.id,
    );

    return scored[0];
  }

  async rotateApiKey(slug: string): Promise<{ apiKey: string; agent: AgentResponseDto }> {
    const agent = await this.agentRepo.findBySlugScalar(slug);
    if (!agent) throw new NotFoundAppException({}, 'agents');
    return this.generateApiKey(agent.id);
  }
}
