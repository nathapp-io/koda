import { ApiProperty } from '@nestjs/swagger';

export class CommentResponseDto {
  @ApiProperty({
    description: 'Comment unique identifier',
    example: 'comment-123',
  })
  id: string;

  @ApiProperty({
    description: 'Ticket ID this comment belongs to',
    example: 'ticket-123',
  })
  ticketId: string;

  @ApiProperty({
    description: 'Comment body text',
    example: 'This is a test comment',
  })
  body: string;

  @ApiProperty({
    description: 'Comment type',
    example: 'GENERAL',
    enum: ['VERIFICATION', 'FIX_REPORT', 'REVIEW', 'STATUS_CHANGE', 'GENERAL'],
  })
  type: string;

  @ApiProperty({
    description: 'User ID of comment author (if user authored)',
    example: 'user-123',
    nullable: true,
  })
  authorUserId: string | null;

  @ApiProperty({
    description: 'Agent ID of comment author (if agent authored)',
    example: 'agent-123',
    nullable: true,
  })
  authorAgentId: string | null;

  @ApiProperty({
    description: 'Comment creation timestamp',
    example: '2026-03-17T10:00:00Z',
  })
  createdAt: Date;

  @ApiProperty({
    description: 'Comment last update timestamp',
    example: '2026-03-17T10:00:00Z',
  })
  updatedAt: Date;
}
