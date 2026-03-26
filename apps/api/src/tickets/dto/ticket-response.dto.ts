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
}
