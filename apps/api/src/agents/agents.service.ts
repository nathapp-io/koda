import { Injectable, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { IsString, IsOptional, IsNumber, IsArray, IsIn, MinLength, ArrayMinSize } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';
import { NotFoundAppException, ValidationAppException } from '@nathapp/nestjs-common';
import { createHmac, randomBytes } from 'crypto';
import { AGENT_ROLES, type AgentRoleNames } from '../common/enums';
import { AgentResponseDto } from './dto/agent-response.dto';
import { TicketResponseDto } from '../tickets/dto/ticket-response.dto';
import { KodaDomainWriter } from '../koda-domain-writer/koda-domain-writer.service';
import { AgentAuthProvider } from '../auth/agent-auth.provider';
import { PrismaAgentRepository } from './prisma-agent.repository';

export class CreateAgentDto {
  @ApiProperty({ example: 'Subrina Coder' })
  @IsString()
  @MinLength(1)
  name!: string;

  @ApiProperty({ example: 'subrina-coder', required: false })
  @IsOptional()
  @IsString()
  @MinLength(1)
  slug?: string;

  @ApiProperty({ required: false, minimum: 1 })
  @IsOptional()
  @IsNumber()
  maxConcurrentTickets?: number;

  @ApiProperty({ example: ['DEVELOPER', 'REVIEWER'] })
  @IsArray()
  @ArrayMinSize(1)
  @IsString({ each: true })
  @IsIn([...AGENT_ROLES], { each: true })
  roles!: string[];

  @ApiProperty({ required: false, example: ['typescript', 'nestjs'] })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  capabilities?: string[];
}

export class UpdateAgentDto {
  @ApiProperty({ required: false })
  @IsOptional()
  @IsString()
  name?: string;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsString()
  status?: string;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsNumber()
  maxConcurrentTickets?: number;
}

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
    private configService: ConfigService,
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
    const authCfg = this.configService.get<{ apiKeySecret?: string }>('auth');
    const apiKeySecret = authCfg?.apiKeySecret;
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
      // Separate scalar fields from relational fields
      const { roles, capabilities, ...scalarFields } = agentIdOrDto;
      const validatedRoles = AgentsService.validateAgentRoles(roles);
      const slug = scalarFields.slug || scalarFields.name.toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, '');
      const agent = await this.agentRepo.create({
        ...scalarFields,
        slug,
        apiKeyHash,
      });
      await this.agentAuthProvider?.invalidateByTag(`AGENT:${agent.id}`);
      await this.agentRepo.createRolesAndCapabilities(agent.id, validatedRoles, capabilities ?? []);
      const agentWithRelations = {
        ...agent,
        roles: validatedRoles.map((role, index) => ({
          id: `generated-role-${index}`,
          agentId: agent.id,
          role,
        })),
        capabilities: (capabilities ?? []).map((capability, index) => ({
          id: `generated-capability-${index}`,
          agentId: agent.id,
          capability,
        })),
      };
      await this.recordAgentAction(agent.id, 'AGENT_CREATED', { name: agent.name, slug: agent.slug });
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

  async findMe(agentId: string): Promise<AgentResponseDto> {
    const agent = await this.agentRepo.findById(agentId);

    if (!agent) {
      throw new NotFoundAppException({}, 'agents');
    }

    return AgentResponseDto.from(agent);
  }

  async findByProject(projectSlug: string): Promise<AgentResponseDto[]> {
    const result = await this.agentRepo.findByProjectSlug(projectSlug);
    if (!result) throw new NotFoundAppException({}, 'projects');
    return AgentResponseDto.fromMany(result.agents);
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

  async suggestTicket(agentSlug: string, projectSlug: string) {
    const agent = await this.agentRepo.findBySlugWithCapabilities(agentSlug);
    if (!agent) throw new NotFoundAppException({}, 'agents');

    const project = await this.agentRepo.findProjectBySlug(projectSlug);
    if (!project) return null;

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
