import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsIn, IsOptional } from 'class-validator';

/**
 * The two sources a REST caller may delete (permissions P1 US-007).
 *
 * A KB row is identified by `(source, sourceId)`, so `DELETE …/kb/documents/:sourceId` takes an optional
 * `source` to name one of them. Ticket and code rows are not deletable over REST: the ticket lifecycle and
 * the code-graph diff own theirs. Omitted, the route deletes both user sources.
 */
export const KB_DELETE_SOURCES = ['doc', 'manual'] as const;

export type KbDeleteSource = (typeof KB_DELETE_SOURCES)[number];

export class DeleteKbDocumentQuery {
  @ApiPropertyOptional({ enum: KB_DELETE_SOURCES, description: 'Restrict the delete to one user source' })
  @IsOptional()
  @IsIn([...KB_DELETE_SOURCES])
  source?: KbDeleteSource;
}
