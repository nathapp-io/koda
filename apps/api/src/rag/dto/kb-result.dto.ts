import { ApiProperty } from '@nestjs/swagger';

export type SimilarityLevel = 'high' | 'medium' | 'low' | 'none';
export type VerdictType = 'likely_duplicate' | 'possibly_related' | 'no_match';

export class KbResultDto {
  @ApiProperty({ description: 'Document ID' })
  id!: string;

  @ApiProperty({ enum: ['ticket', 'doc', 'manual', 'code'], description: 'Source type' })
  source!: string;

  @ApiProperty({ description: 'Source record ID' })
  sourceId!: string;

  @ApiProperty({ description: 'Full text content' })
  content!: string;

  @ApiProperty({ description: 'Vector similarity score (0-1)' })
  score!: number;

  @ApiProperty({ enum: ['high', 'medium', 'low', 'none'], description: 'Similarity tier' })
  similarity!: SimilarityLevel;

  @ApiProperty({ description: 'Metadata JSON' })
  metadata!: Record<string, unknown>;

  @ApiProperty({ description: 'ISO timestamp when indexed' })
  createdAt!: string;
}

export class SearchKbResponseDto {
  @ApiProperty({ type: [KbResultDto] })
  results!: KbResultDto[];

  @ApiProperty({
    enum: ['likely_duplicate', 'possibly_related', 'no_match'],
    description: 'Overall verdict based on top result score',
  })
  verdict!: VerdictType;
}
