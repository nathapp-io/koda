import { ApiProperty } from '@nestjs/swagger';

/**
 * US-002: one row in a project's explicit agent roster. Reads the project's local agent bindings
 * (not ticket assignments), so rostered agents without tickets appear and ticket holders without a
 * roster row do not.
 *
 * Permissions P1l US-006: the row carries no `roles` — an agent's roles are role bindings — and the
 * roster envelope carries no `scoping` flag, which was always true.
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
  capabilities: string[];
  openTicketCount: number;
  openTicketRefs: string[];
  addedAt: Date;
  addedById: string | null;
  addedByName: string | null;
}

export class ProjectAgentListDto {
  @ApiProperty({ type: ProjectAgentDto, isArray: true })
  items!: ProjectAgentDto[];

  static from(records: readonly ProjectAgentRecord[]): ProjectAgentListDto {
    return {
      items: ProjectAgentDto.fromMany(records),
    };
  }
}
