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

/**
 * US-002: one row in a project's explicit agent roster. Reads from the
 * AgentProject table (not from ticket assignments), so rostered agents without
 * tickets appear and ticket holders without a roster row do not.
 */
export class ProjectAgentAddedByDto {
  @ApiProperty()
  id!: string;

  @ApiProperty({ nullable: true, type: String })
  name!: string | null;
}

export class ProjectAgentDto {
  @ApiProperty()
  slug!: string;

  @ApiProperty()
  name!: string;

  @ApiProperty()
  status!: string;

  @ApiProperty({ type: String, isArray: true })
  roles!: string[];

  @ApiProperty({ type: String, isArray: true })
  capabilities!: string[];

  @ApiProperty()
  openTicketCount!: number;

  @ApiProperty({ type: String, isArray: true })
  openTicketRefs!: string[];

  @ApiProperty()
  addedAt!: string;

  @ApiProperty({ type: ProjectAgentAddedByDto, nullable: true })
  addedBy!: ProjectAgentAddedByDto | null;

  static from(record: ProjectAgentRecord): ProjectAgentDto {
    return {
      slug: record.slug,
      name: record.name,
      status: record.status,
      roles: [...record.roles],
      capabilities: [...record.capabilities],
      openTicketCount: record.openTicketCount,
      openTicketRefs: [...record.openTicketRefs],
      addedAt: record.addedAt.toISOString(),
      addedBy: record.addedById
        ? { id: record.addedById, name: record.addedByName ?? null }
        : null,
    };
  }

  static fromMany(records: readonly ProjectAgentRecord[]): ProjectAgentDto[] {
    return records.map((record) => ProjectAgentDto.from(record));
  }
}

/** Raw shape the repository returns; the service turns it into ProjectAgentDto. */
export interface ProjectAgentRecord {
  slug: string;
  name: string;
  status: string;
  roles: readonly string[];
  capabilities: readonly string[];
  openTicketCount: number;
  openTicketRefs: readonly string[];
  addedAt: Date;
  addedById: string | null;
  addedByName: string | null;
}

export class ProjectAgentListDto {
  @ApiProperty()
  scoping!: boolean;

  @ApiProperty({ type: ProjectAgentDto, isArray: true })
  items!: ProjectAgentDto[];

  static from(
    records: readonly ProjectAgentRecord[],
    scoping: boolean,
  ): ProjectAgentListDto {
    return {
      scoping,
      items: ProjectAgentDto.fromMany(records),
    };
  }
}