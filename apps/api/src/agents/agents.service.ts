import { Injectable, Optional, Inject } from '@nestjs/common';
import { IsArray, IsString } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';
import { NotFoundAppException, ValidationAppException, ForbiddenAppException } from '@nathapp/nestjs-common';
import { ITransactionManager, TRANSACTION_MANAGER } from '@nathapp/nestjs-data';
import { createHmac, randomBytes } from 'crypto';
import { AgentResponseDto } from './dto/agent-response.dto';
import { AgentMeResponseDto } from './dto/agent-me-response.dto';
import { ProjectAgentListDto } from './dto/project-agent.dto';
import { TicketResponseDto } from '../tickets/dto/ticket-response.dto';
import { KodaPrincipal } from '../auth/principal/koda-principal.types';
import { KodaDomainWriter } from '../koda-domain-writer/koda-domain-writer.service';
import { AgentAuthProvider } from '../auth/agent-auth.provider';
import { PrismaAgentRepository } from './prisma-agent.repository';
import { AUTH_CFG, IAuthConfig } from '../config/auth.config';
import { MembershipService } from '../permissions/membership.service';
import { PermissionService } from '../permissions/permission.service';
import { ConflictAppException } from '../common/exceptions/conflict-app.exception';
import { isUniqueViolation } from '../common/utils/prisma-errors';
import { CreateAgentDto } from './dto/create-agent.dto';
import { UpdateAgentDto } from './dto/update-agent.dto';

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
    private readonly membership: MembershipService,
    // Permissions P1 (US-009): pickup is authorized by the *target* agent's project keys, so the
    // service asks the one permission decision point. Required, and before the two optional seams.
    private readonly permissions: PermissionService,
    @Optional() private readonly kodaDomainWriter?: KodaDomainWriter,
    @Optional() private readonly agentAuthProvider?: AgentAuthProvider,
  ) {}

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
      const { capabilities, ...scalarFields } = agentIdOrDto;
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

      // US-003: wrap the agent row and capability writes in a single
      // `txManager.run` callback. A failed capability write rejects out of
      // the callback and the transaction manager rolls back the agent row.
      // Permissions P1a (US-004): the baseline binding is inside the same callback, so a rolled-back
      // create leaves no RoleBinding row for the agent either. `afterCommit` keeps the permission-cache
      // invalidation of that nested write until this transaction committed (B3).
      // Permissions P1l (US-005): creation writes no `AgentRoleEntry` — an agent's roles are bindings.
      const result = await this.membership.afterCommit(() =>
        this.txManager.run(async () => {
          const agent = await this.agentRepo.create(createData).catch((error: unknown) => {
            if (isUniqueViolation(error, 'slug')) {
              throw new ConflictAppException({}, 'agents');
            }
            throw error;
          });
          await this.agentRepo.createCapabilities(agent.id, capabilities ?? []);
          await this.membership.bindBaseline({ type: 'AGENT', id: agent.id });
          return agent;
        }),
      );
      await this.agentAuthProvider?.invalidateByTag(`AGENT:${result.id}`);
      const agentWithCapabilities = {
        ...result,
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
        agent: AgentResponseDto.from(agentWithCapabilities),
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
   * US-002 (D530): the project's explicit agent roster. Reads local compatibility
   * membership sources — rostered agents without tickets appear; ticket holders without a
   * roster row do not. Throws 404 when the project is missing or soft-deleted
   * so callers can surface a stable error without guessing from an empty list.
   *
   * `scoping` is always true: agent project reach is decided by `project.read`.
   */
  async listProjectRoster(projectSlug: string): Promise<ProjectAgentListDto> {
    const project = await this.agentRepo.findProjectBySlug(projectSlug);
    if (!project || project.deletedAt) {
      throw new NotFoundAppException({}, 'projects');
    }

    const records = await this.agentRepo.findProjectRoster(project.id);
    return ProjectAgentListDto.from(records, true);
  }

  /**
   * True when the agent is on the project's roster. A single membership lookup:
   * no roster listing and no open-ticket scan, so it is cheap to call per request.
   */
  async isOnProjectRosterBySlug(projectSlug: string, agentSlug: string): Promise<boolean> {
    const project = await this.agentRepo.findProjectBySlug(projectSlug);
    if (!project || project.deletedAt) return false;
    const agent = await this.agentRepo.findBySlugScalar(agentSlug);
    if (!agent) return false;
    return this.agentRepo.isOnProjectRoster(agent.id, project.id);
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
    // Permissions P1a (US-004): `RoleBinding.principalId` has no foreign key, so the agent's bindings
    // outlive its row. A deleted principal must not keep a role.
    await this.membership.removeAllBindings({ type: 'AGENT', id: agent.id });
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
   * US-003: ticket pickup is gated to the agent itself, or to a caller that holds `agent.update`
   * (with the seeded roles: an Owner or an Admin). 403 for everyone else; 404 when the project is
   * missing or soft-deleted.
   *
   * Permissions P1 (US-002): acting for another agent is a permission key, not a `role: 'ADMIN'`
   * claim. The owning agent is its own caller and asks nothing; any other caller is refused before a
   * target-agent key is read.
   *
   * S4c US-001: a pickup is the target agent's act inside the project, so the
   * target agent must hold `agent.pickup` there. Permissions P1 (US-009): that is
   * the target agent's effective project keys, not the caller's — a global ADMIN
   * cannot pick up on behalf of an agent whose bindings grant no pickup key in the project.
   */
  async suggestTicket(
    agentSlug: string,
    projectSlug: string,
    principal: KodaPrincipal,
  ) {
    // Authorize: the matching agent acts for itself; anyone else needs `agent.update`.
    const isOwningAgent = principal.actorType === 'agent' && principal.slug === agentSlug;
    if (!isOwningAgent && !(await this.permissions.can(principal, 'agent.update')).allowed) {
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

    const targetKeys = await this.permissions.effectiveKeys(
      { type: 'AGENT', id: agent.id },
      { projectId: project.id },
    );
    if (!targetKeys.has('agent.pickup')) {
      throw new ForbiddenAppException({}, 'permissions');
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
