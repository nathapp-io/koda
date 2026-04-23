import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsArray, IsNumber, IsOptional, IsString, Max, Min } from 'class-validator';
import { Type } from 'class-transformer';

export class HybridSearchQuery {
  @ApiProperty({ description: 'Project ID to search within' })
  @IsString()
  projectId!: string;

  @ApiProperty({ description: 'Natural language search query' })
  @IsString()
  query!: string;

  @ApiPropertyOptional({ default: 20, minimum: 1, maximum: 50 })
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(1)
  @Max(50)
  limit?: number = 20;

  @ApiPropertyOptional({ description: 'Intent category for weight selection', required: false })
  @IsOptional()
  @IsString()
  intent?: string;

  @ApiPropertyOptional({ description: 'Time window filter start (ISO timestamp)', required: false })
  @IsOptional()
  @IsString()
  timeWindow?: { start?: string; end?: string };

  @ApiPropertyOptional({ description: 'Ticket IDs to filter by (Phase 2: accepted, not filtered)', required: false })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  ticketIds?: string[];

  @ApiPropertyOptional({ description: 'Repository references to filter by (Phase 2: accepted, not filtered)', required: false })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  repoRefs?: string[];
}

export class ScoreBreakdown {
  @ApiProperty({ description: 'Vector similarity score' })
  vectorScore!: number;

  @ApiProperty({ description: 'Full-text search score' })
  lexicalScore!: number;

  @ApiProperty({ description: 'Entity matching score' })
  entityScore!: number;

  @ApiProperty({ description: 'Recency score' })
  recencyScore!: number;

  @ApiProperty({ description: 'Final combined score' })
  finalScore!: number;
}

export class HybridSearchResultItem {
  @ApiProperty({ description: 'Document ID' })
  id!: string;

  @ApiProperty({ enum: ['ticket', 'doc', 'manual', 'code'], description: 'Source type' })
  source!: 'ticket' | 'doc' | 'manual' | 'code';

  @ApiProperty({ description: 'Source record ID' })
  sourceId!: string;

  @ApiProperty({ description: 'Full text content' })
  content!: string;

  @ApiProperty({ description: 'Combined relevance score' })
  score!: number;

  @ApiProperty({ enum: ['high', 'medium', 'low', 'none'], description: 'Similarity tier' })
  similarity!: 'high' | 'medium' | 'low' | 'none';

  @ApiProperty({ description: 'Metadata JSON' })
  metadata!: Record<string, unknown>;

  @ApiProperty({ description: 'ISO timestamp when indexed' })
  createdAt!: string;

  @ApiProperty({ description: 'Provenance information' })
  provenance!: {
    indexedAt: string;
    sourceProjectId: string;
  };
}

export class HybridSearchResult {
  @ApiProperty({ type: [HybridSearchResultItem] })
  results!: HybridSearchResultItem[];

  @ApiProperty({ type: [ScoreBreakdown] })
  scores!: ScoreBreakdown[];

  @ApiProperty({ description: 'ISO timestamp when search was performed' })
  retrievedAt!: string;
}