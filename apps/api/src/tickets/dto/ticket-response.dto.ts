import { ApiProperty } from '@nestjs/swagger';
import { TicketType, TicketStatus, Priority } from '../../common/enums';
import { TicketLinkResponseDto } from '../../ticket-links/dto/ticket-link-response.dto';

export class TicketResponseDto {
  @ApiProperty({ description: 'Ticket ID (CUID)' })
  id!: string;

  @ApiProperty({ description: 'Project ID' })
  projectId!: string;

  @ApiProperty({ description: 'Sequential ticket number within project' })
  number!: number;

  @ApiProperty({ description: 'Project-scoped ticket reference, e.g. NAX-1' })
  ref!: string;

  @ApiProperty({ description: 'Ticket type', enum: TicketType })
  type!: TicketType;

  @ApiProperty({ description: 'Ticket title' })
  title!: string;

  @ApiProperty({ description: 'Ticket description', nullable: true })
  description?: string | null;

  @ApiProperty({ description: 'Ticket status', enum: TicketStatus })
  status!: TicketStatus;

  @ApiProperty({ description: 'Ticket priority', enum: Priority })
  priority!: Priority;

  @ApiProperty({ description: 'Assigned to user ID', nullable: true })
  assignedToUserId?: string | null;

  @ApiProperty({ description: 'Assigned to agent ID', nullable: true })
  assignedToAgentId?: string | null;

  @ApiProperty({ description: 'Created by user ID', nullable: true })
  createdByUserId?: string | null;

  @ApiProperty({ description: 'Created by agent ID', nullable: true })
  createdByAgentId?: string | null;

  @ApiProperty({ description: 'Git reference version', nullable: true })
  gitRefVersion?: string | null;

  @ApiProperty({ description: 'Git reference file', nullable: true })
  gitRefFile?: string | null;

  @ApiProperty({ description: 'Git reference line', nullable: true })
  gitRefLine?: number | null;

  @ApiProperty({ description: 'Git reference URL', nullable: true })
  gitRefUrl?: string | null;

  @ApiProperty({ description: 'Created at timestamp' })
  createdAt!: Date;

  @ApiProperty({ description: 'Updated at timestamp' })
  updatedAt!: Date;

  @ApiProperty({ description: 'Soft delete timestamp', nullable: true })
  deletedAt?: Date | null;

  @ApiProperty({
    description: 'Related ticket links',
    isArray: true,
    type: TicketLinkResponseDto,
  })
  links!: TicketLinkResponseDto[];

  @ApiProperty({
    description: 'Labels attached to this ticket',
    isArray: true,
  })
  labels!: { id: string; projectId: string; name: string; color: string | null }[];

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  static from(ticket: any, projectKey?: string, gitRefUrl?: string | null): TicketResponseDto {
    const ref = projectKey
      ? `${projectKey}-${ticket.number}`
      : ticket.ref ?? `${projectKey ?? ''}-${ticket.number}`;

    // Flatten labels from nested TicketLabel structure if present
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let labels: any[] = [];
    if (ticket.labels && Array.isArray(ticket.labels)) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      labels = ticket.labels.map((tl: any) =>
        tl.label
          ? { id: tl.label.id, projectId: tl.label.projectId, name: tl.label.name, color: tl.label.color }
          : tl,
      );
    }

    // Map raw links to TicketLinkResponseDto shape
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const links: TicketLinkResponseDto[] = (ticket.links ?? []).map((l: any) => ({
      id: l.id,
      ticketId: l.ticketId,
      url: l.url,
      provider: l.provider,
      externalRef: l.externalRef,
      prState: l.prState ?? null,
      prNumber: l.prNumber ?? null,
      prUpdatedAt: l.prUpdatedAt ?? null,
      createdAt: l.createdAt,
    }));

    return {
      id: ticket.id,
      projectId: ticket.projectId,
      number: ticket.number,
      ref,
      type: ticket.type,
      title: ticket.title,
      description: ticket.description,
      status: ticket.status,
      priority: ticket.priority,
      assignedToUserId: ticket.assignedToUserId,
      assignedToAgentId: ticket.assignedToAgentId,
      createdByUserId: ticket.createdByUserId,
      createdByAgentId: ticket.createdByAgentId,
      gitRefVersion: ticket.gitRefVersion,
      gitRefFile: ticket.gitRefFile,
      gitRefLine: ticket.gitRefLine,
      gitRefUrl: gitRefUrl ?? ticket.gitRefUrl ?? null,
      createdAt: ticket.createdAt,
      updatedAt: ticket.updatedAt,
      deletedAt: ticket.deletedAt,
      labels,
      links,
    };
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  static fromMany(tickets: any[], projectKey?: string): TicketResponseDto[] {
    return tickets.map(t => TicketResponseDto.from(t, projectKey));
  }
}
