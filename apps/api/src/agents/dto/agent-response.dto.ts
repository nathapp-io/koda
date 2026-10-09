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

/** S4c US-001: one non-deleted project on an agent's roster (GET /agents/me). */
export class AgentMeProjectDto {
  @ApiProperty()
  slug!: string;

  @ApiProperty()
  name!: string;
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

/**
 * S4c US-001: the agent's own profile (GET /agents/me). Same fields as
 * AgentResponseDto plus the non-deleted projects on its roster, slug-ordered.
 */
export class AgentMeResponseDto extends AgentResponseDto {
  @ApiProperty({ type: AgentMeProjectDto, isArray: true })
  projects!: AgentMeProjectDto[];

  static fromMe(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    agent: any,
    projects: readonly { slug: string; name: string }[],
  ): AgentMeResponseDto {
    return {
      ...AgentResponseDto.from(agent),
      projects: projects.map((p) => ({ slug: p.slug, name: p.name })),
    };
  }
}