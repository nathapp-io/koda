import { ApiProperty } from '@nestjs/swagger';
import { IsIn, IsObject, IsOptional, IsString, MinLength } from 'class-validator';

/**
 * The two sources a REST caller may write (permissions P1 US-007).
 *
 * `ticket` and `code` rows belong to the ticket indexer and the code graph (`KbTicketLifecycleSubscriber`,
 * `IncrementalGraphDiffService`), which index them internally. A REST caller that could name them could
 * overwrite a system row of the same `sourceId`, so the DTO refuses them with 400 before the handler runs.
 * `IndexDocumentInput` keeps the wider union: the internal writers still index every source.
 */
export const KB_REST_ADD_SOURCES = ['doc', 'manual'] as const;

export type KbRestAddSource = (typeof KB_REST_ADD_SOURCES)[number];

export class AddDocumentDto {
  @ApiProperty({ enum: KB_REST_ADD_SOURCES, description: 'Source type (the two user-writable sources)' })
  @IsString()
  @IsIn([...KB_REST_ADD_SOURCES])
  source!: KbRestAddSource;

  @ApiProperty({ description: 'Source record ID of the document being indexed' })
  @IsString()
  @MinLength(1)
  sourceId!: string;

  @ApiProperty({ description: 'Full text content to embed and index' })
  @IsString()
  @MinLength(1)
  content!: string;

  @ApiProperty({ required: false, description: 'Arbitrary metadata stored with the document' })
  @IsOptional()
  @IsObject()
  metadata?: Record<string, unknown>;
}
