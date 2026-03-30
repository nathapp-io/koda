import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { IsString, IsOptional, IsNumber, IsArray, MinLength } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';
import { PrismaService } from '@nathapp/nestjs-prisma';
import { NotFoundAppException } from '@nathapp/nestjs-common';
import { createHmac, randomBytes } from 'crypto';
import type { PrismaClient } from '@prisma/client';
import { AgentRole } from '../common/enums';
import { AgentResponseDto } from './dto/agent-response.dto';
import { TicketResponseDto } from '../tickets/dto/ticket-response.dto';

export class CreateAgentDto {
  @ApiProperty({ example: 'Subrina Coder' })
  @IsString()
  @MinLength(1)
  name!: string;

  @ApiProperty({ example: 'subrina-coder' })
  @IsString()
  @MinLength(1)
  slug!: string;

  @ApiProperty({ required: false, minimum: 1 })
  @IsOptional()
  @IsNumber()
  maxConcurrentTickets?: number;

  @ApiProperty({ required: false, example: ['DEVELOPER', 'REVIEWER'] })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  roles?: string[];

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
    private prisma: PrismaService<PrismaClient>,
    private configService: ConfigService,
  ) {}
  private get db() { return this.prisma.client; }


  async generateApiKey(agentId: string): Promise<{ apiKey: string; agent: AgentResponseDto }>;
  async generateApiKey(dto: CreateAgentDto): Promise<{ apiKey: string; agent: AgentResponseDto }>;
  async generateApiKey(agentIdOrDto: string | CreateAgentDto) {
    // Generate random 32-byte hex key
    const rawKey = randomBytes(32).toString('hex');

    // Compute HMAC-SHA256 hash with API_KEY_SECRET
    const authCfg = this.configService.get<{ apiKeySecret?: string }>('auth');
    const apiKeySecret = authCfg?.apiKeySecret;
    if (!apiKeySecret) {
      throw new Error('API_KEY_SECRET is not configured');
    }

    const apiKeyHash = createHmac('sha256', apiKeySecret).update(rawKey).digest('hex');

    // Determine if this is an update (string) or create (object)
    let agent: Awaited<ReturnType<typeof this.db.agent.update>>;
    if (typeof agentIdOrDto === 'string') {
      // Update existing agent
      agent = await this.db.agent.update({
        where: { id: agentIdOrDto },
        data: { apiKeyHash },
      });
      // Re-fetch with relations for DTO mapping
      const agentWithRelations = await this.db.agent.findUnique({
        where: { id: agent.id },
        include: { roles: true, capabilities: true },
      });
      return {
        apiKey: rawKey,
        agent: AgentResponseDto.from(agentWithRelations),
      };
    } else {
      // Separate scalar fields from relational fields
      const { roles, capabilities, ...scalarFields } = agentIdOrDto;
      agent = await this.db.agent.create({
        data: {
          ...scalarFields,
          apiKeyHash,
        },
      });
      // Create role entries (sequential create — createMany not reliable on SQLite for junction tables)
      const createdRoles = [];
      if (roles?.length) {
        for (const role of roles) {
          const entry = await this.db.agentRoleEntry.create({
            data: { agentId: agent.id, role: role as AgentRole },
          });
          createdRoles.push(entry);
        }
      }
      // Create capability entries
      const createdCapabilities = [];
      if (capabilities?.length) {
        for (const capability of capabilities) {
          const entry = await this.db.agentCapabilityEntry.create({
            data: { agentId: agent.id, capability },
          });
          createdCapabilities.push(entry);
        }
      }
      // Build agent with relations from created entries (avoid extra findUnique call)
      const agentWithRelations = {
        ...agent,
        roles: createdRoles,
        capabilities: createdCapabilities,
      };
      // Return raw key ONCE to client (never return the hash)
      return {
        apiKey: rawKey,
        agent: AgentResponseDto.from(agentWithRelations),
      };
    }
  }

  async findAll(): Promise<AgentResponseDto[]> {
    return AgentResponseDto.fromMany(await this.db.agent.findMany({
      include: {
        roles: true,
        capabilities: true,
      },
    }));
  }

  async findBySlug(slug: string): Promise<AgentResponseDto> {
    const agent = await this.db.agent.findUnique({
      where: { slug },
      include: {
        roles: true,
        capabilities: true,
      },
    });

    if (!agent) {
      throw new NotFoundAppException({}, 'agents');
    }

    return AgentResponseDto.from(agent);
  }

  async findMe(agentId: string): Promise<AgentResponseDto> {
    const agent = await this.db.agent.findUnique({
      where: { id: agentId },
      include: {
        roles: true,
        capabilities: true,
      },
    });

    if (!agent) {
      throw new NotFoundAppException({}, 'agents');
    }

    return AgentResponseDto.from(agent);
  }

  async update(slug: string, updateData: UpdateAgentDto): Promise<AgentResponseDto> {
    const agent = await this.db.agent.findUnique({ where: { slug } });
    if (!agent) throw new NotFoundAppException({}, 'agents');

    const data: Partial<{ name: string; status: string; maxConcurrentTickets: number }> = {};
    if (updateData.name !== undefined) data.name = updateData.name;
    if (updateData.maxConcurrentTickets !== undefined) data.maxConcurrentTickets = updateData.maxConcurrentTickets;
    if (updateData.status !== undefined) data.status = updateData.status;

    const updated = await this.db.agent.update({
      where: { slug },
      data,
      include: { roles: true, capabilities: true },
    });
    return AgentResponseDto.from(updated);
  }

  async updateRoles(agentId: string, updateData: UpdateRolesDto): Promise<AgentResponseDto> {
    // Delete all existing roles
    await this.db.agentRoleEntry.deleteMany({
      where: { agentId },
    });

    // Create new roles if provided
    if (updateData.roles && updateData.roles.length > 0) {
      await this.db.agentRoleEntry.createMany({
        data: updateData.roles.map((role) => ({
          agentId,
          role: role as AgentRole,
        })),
      });
    }

    // Return updated agent with roles
    return AgentResponseDto.from(await this.db.agent.findUnique({
      where: { id: agentId },
      include: {
        roles: true,
        capabilities: true,
      },
    }));
  }

  async updateCapabilities(agentId: string, updateData: UpdateCapabilitiesDto): Promise<AgentResponseDto> {
    // Delete all existing capabilities
    await this.db.agentCapabilityEntry.deleteMany({
      where: { agentId },
    });

    // Create new capabilities if provided
    if (updateData.capabilities && updateData.capabilities.length > 0) {
      // Filter out duplicates
      const uniqueCapabilities = [...new Set(updateData.capabilities)];
      await this.db.agentCapabilityEntry.createMany({
        data: uniqueCapabilities.map((capability) => ({
          agentId,
          capability,
        })),
      });
    }

    // Return updated agent with capabilities
    return AgentResponseDto.from(await this.db.agent.findUnique({
      where: { id: agentId },
      include: {
        roles: true,
        capabilities: true,
      },
    }));
  }

  async remove(slug: string): Promise<AgentResponseDto> {
    const agent = await this.db.agent.findUnique({
      where: { slug },
      include: { roles: true, capabilities: true },
    });
    if (!agent) throw new NotFoundAppException({}, 'agents');

    await this.db.agent.delete({ where: { slug } });
    return AgentResponseDto.from(agent);
  }

  private static readonly PRIORITY_RANK: Record<string, number> = {
    CRITICAL: 4,
    HIGH: 3,
    MEDIUM: 2,
    LOW: 1,
  };

  async suggestTicket(agentSlug: string, projectSlug: string) {
    const agent = await this.db.agent.findUnique({
      where: { slug: agentSlug },
      include: { capabilities: true },
    });
    if (!agent) throw new NotFoundAppException({}, 'agents');

    const project = await this.db.project.findUnique({ where: { slug: projectSlug } });
    if (!project) return null;

    const tickets = await this.db.ticket.findMany({
      where: {
        projectId: project.id,
        status: 'VERIFIED',
        assignedToAgentId: null,
        assignedToUserId: null,
        deletedAt: null,
      },
      include: {
        labels: { include: { label: true } },
      },
    });

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

    return scored[0];
  }

  async rotateApiKey(slug: string): Promise<{ apiKey: string; agent: AgentResponseDto }> {
    const agent = await this.db.agent.findUnique({ where: { slug } });
    if (!agent) throw new NotFoundAppException({}, 'agents');
    return this.generateApiKey(agent.id);
  }
}
