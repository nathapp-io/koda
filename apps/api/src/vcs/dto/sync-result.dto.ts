import { ApiProperty } from '@nestjs/swagger';

export class SyncResultDto {
  @ApiProperty({
    description: 'How this sync was triggered',
    example: 'manual',
  })
  syncType: string;

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
    description: 'List of created ticket refs',
    type: 'array',
    items: {
      type: 'object',
      properties: {
        ref: { type: 'string', example: 'PROJ-1' },
        title: { type: 'string', example: 'Imported GitHub issue' },
      },
    },
  })
  tickets: Array<{
    ref: string;
    title: string;
  }>;
}
