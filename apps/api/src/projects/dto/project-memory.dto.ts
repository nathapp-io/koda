import { IsString, IsOptional, IsIn } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { MemoryKind } from '../../common/enums';

export class GetProjectMemoryDto {
  @ApiPropertyOptional({
    description: 'Filter by memory kind',
    enum: ['FACT', 'INCIDENT_PATTERN', 'DECISION'],
  })
  @IsOptional()
  @IsString()
  @IsIn(['FACT', 'INCIDENT_PATTERN', 'DECISION'])
  kind?: MemoryKind;

  @ApiPropertyOptional({
    description: 'Filter memories with subject starting with this prefix',
    example: 'ticket:123',
  })
  @IsOptional()
  @IsString()
  subjects?: string;

  @ApiPropertyOptional({
    description: 'Filter by status (active, superseded, rejected)',
    example: 'active',
  })
  @IsOptional()
  @IsString()
  status?: string;
}

export class MemoryItemResponseDto {
  @ApiProperty({ description: 'Memory item ID' })
  id!: string;

  @ApiProperty({ description: 'Project ID' })
  projectId!: string;

  @ApiProperty({ description: 'Memory kind', enum: ['FACT', 'INCIDENT_PATTERN', 'DECISION'] })
  kind!: string;

  @ApiProperty({ description: 'Memory subject', example: 'ticket:123' })
  subject!: string;

  @ApiProperty({ description: 'Memory predicate', example: 'status' })
  predicate!: string;

  @ApiPropertyOptional({ description: 'Memory object value' })
  object?: string;

  @ApiPropertyOptional({ description: 'Confidence score (0.0 - 1.0)' })
  confidence?: number;

  @ApiPropertyOptional({ description: 'ID of the memory item that superseded this one' })
  supersededBy?: string;

  @ApiProperty({ description: 'Creation timestamp' })
  createdAt!: Date;

  @ApiProperty({ description: 'Last update timestamp' })
  updatedAt!: Date;
}

export class ProjectMemoryResponseDto {
  @ApiProperty({ description: 'Total number of matching memories' })
  total!: number;

  @ApiProperty({ description: 'Memory items', type: [MemoryItemResponseDto] })
  items!: MemoryItemResponseDto[];
}