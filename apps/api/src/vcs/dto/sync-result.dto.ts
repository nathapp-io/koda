import { ApiProperty } from '@nestjs/swagger';

export class SyncResultDto {
  @ApiProperty({
    description: 'Number of issues successfully synced',
    example: 3,
  })
  issuesSynced: number;

  @ApiProperty({
    description: 'Number of issues skipped (already synced or filtered)',
    example: 2,
  })
  issuesSkipped: number;

  @ApiProperty({
    description: 'List of created ticket references',
    type: 'array',
    items: {
      type: 'object',
      properties: {
        id: { type: 'string', example: 'ticket-123' },
        projectKey: { type: 'string', example: 'PROJ' },
        number: { type: 'number', example: 1 },
      },
    },
  })
  createdTickets: Array<{
    id: string;
    projectKey: string;
    number: number;
  }>;

  @ApiProperty({
    description: 'List of errors encountered during sync (optional)',
    type: 'array',
    items: { type: 'string' },
    required: false,
    example: ['Issue 100: Network timeout'],
  })
  errors?: string[];
}
