import { ApiProperty } from '@nestjs/swagger';

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
      roles: record.roles,
      capabilities: record.capabilities,
      openTicketCount: record.openTicketCount,
      openTicketRefs: record.openTicketRefs,
      addedAt: record.addedAt.toISOString(),
      addedBy: record.addedById
        ? { id: record.addedById, name: record.addedByName }
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
  roles: string[];
  capabilities: string[];
  openTicketCount: number;
  openTicketRefs: string[];
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
