import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { IsString, IsOptional, IsNumber, IsArray, MinLength } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';
import { PrismaService } from '@nathapp/nestjs-prisma';
import { NotFoundAppException } from '@nathapp/nestjs-common';
import { createHmac, randomBytes } from 'crypto';
import type { PrismaClient } from '@prisma/client';
import { AgentRole } from '../common/enums';

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


  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  async generateApiKey(agentId: string): Promise<{ apiKey: string; agent: any }>;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  async generateApiKey(dto: CreateAgentDto): Promise<{ apiKey: string; agent: any }>;
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
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let agent: any;
    if (typeof agentIdOrDto === 'string') {
      // Update existing agent
      agent = await this.db.agent.update({
        where: { id: agentIdOrDto },
        data: { apiKeyHash },
      });
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
      if (roles?.length) {
        for (const role of roles) {
          await this.db.agentRoleEntry.create({
            data: { agentId: agent.id, role: role as AgentRole },
          });
        }
      }
      // Create capability entries
      if (capabilities?.length) {
        for (const capability of capabilities) {
          await this.db.agentCapabilityEntry.create({
            data: { agentId: agent.id, capability },
          });
        }
      }
    }

    // Return raw key ONCE to client (never return the hash)
    return {
      apiKey: rawKey,
      agent,
    };
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  async findAll(): Promise<any[]> {
    return this.db.agent.findMany({
      include: {
        roles: true,
        capabilities: true,
      },
    });
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  async findBySlug(slug: string): Promise<any> {
    const agent = await this.db.agent.findUnique({
      where: { slug },
      include: {
        roles: true,
        capabilities: true,
      },
    });

    if (!agent) {
      throw new NotFoundAppException();
    }

    return agent;
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  async findMe(agentId: string): Promise<any> {
    const agent = await this.db.agent.findUnique({
      where: { id: agentId },
      include: {
        roles: true,
        capabilities: true,
      },
    });

    if (!agent) {
      throw new NotFoundAppException();
    }

    return agent;
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  async update(slug: string, updateData: UpdateAgentDto): Promise<any> {
    const agent = await this.db.agent.findUnique({ where: { slug } });
    if (!agent) throw new NotFoundAppException();

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const data: any = {};
    if (updateData.name !== undefined) data.name = updateData.name;
    if (updateData.maxConcurrentTickets !== undefined) data.maxConcurrentTickets = updateData.maxConcurrentTickets;
    if (updateData.status !== undefined) data.status = updateData.status;

    return this.db.agent.update({
      where: { slug },
      data,
    });
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  async updateRoles(agentId: string, updateData: UpdateRolesDto): Promise<any> {
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
    return this.db.agent.findUnique({
      where: { id: agentId },
      include: {
        roles: true,
        capabilities: true,
      },
    });
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  async updateCapabilities(agentId: string, updateData: UpdateCapabilitiesDto): Promise<any> {
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
    return this.db.agent.findUnique({
      where: { id: agentId },
      include: {
        roles: true,
        capabilities: true,
      },
    });
  }

  async remove(slug: string): Promise<any> {
    const agent = await this.db.agent.findUnique({
      where: { slug },
      include: { roles: true, capabilities: true },
    });
    if (!agent) throw new NotFoundAppException();

    await this.db.agent.delete({ where: { slug } });
    return agent;
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  async rotateApiKey(slug: string): Promise<{ apiKey: string; agent: any }> {
    // Find agent by slug to get the id
    const agent = await this.db.agent.findUnique({
      where: { slug },
    });

    if (!agent) {
      throw new NotFoundAppException();
    }

    // Rotate key using agent id
    return this.generateApiKey(agent.id);
  }
}
