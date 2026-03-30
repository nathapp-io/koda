import { ApiProperty } from '@nestjs/swagger';

export class AgentRoleDto {
  @ApiProperty()
  id!: string;

  @ApiProperty()
  agentId!: string;

  @ApiProperty()
  role!: string;
}

export class AgentCapabilityDto {
  @ApiProperty()
  id!: string;

  @ApiProperty()
  agentId!: string;

  @ApiProperty()
  capability!: string;
}

export class AgentResponseDto {
  @ApiProperty()
  id!: string;

  @ApiProperty()
  name!: string;

  @ApiProperty()
  slug!: string;

  @ApiProperty()
  status!: string;

  @ApiProperty()
  maxConcurrentTickets!: number;

  @ApiProperty({ type: AgentRoleDto, isArray: true })
  roles!: AgentRoleDto[];

  @ApiProperty({ type: AgentCapabilityDto, isArray: true })
  capabilities!: AgentCapabilityDto[];

  @ApiProperty()
  createdAt!: Date;

  @ApiProperty()
  updatedAt!: Date;

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  static from(agent: any): AgentResponseDto {
    return {
      id: agent.id,
      name: agent.name,
      slug: agent.slug,
      status: agent.status,
      maxConcurrentTickets: agent.maxConcurrentTickets,
      roles: Array.isArray(agent.roles) ? agent.roles : [],
      capabilities: Array.isArray(agent.capabilities) ? agent.capabilities : [],
      createdAt: agent.createdAt,
      updatedAt: agent.updatedAt,
    };
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  static fromMany(agents: any[]): AgentResponseDto[] {
    return agents.map(a => AgentResponseDto.from(a));
  }
}