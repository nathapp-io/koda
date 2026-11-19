import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

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

  @ApiPropertyOptional({
    description: 'Issues the approved import will process, after the allowedAuthors filter. '
      + 'Reported by an approved full import, which imports after the approval commits.',
    example: 3,
  })
  fetchedIssues?: number;

  @ApiPropertyOptional({
    description: 'True when the provider had more issues than the fetch returned, so this import is '
      + 'not the whole backlog.',
    example: true,
  })
  capped?: boolean;
}
