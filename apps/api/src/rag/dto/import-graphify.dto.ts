import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  IsArray,
  IsOptional,
  IsString,
  ValidateNested,
} from 'class-validator';

export class GraphifyNodeDto {
  @ApiProperty({ description: 'Unique node identifier' })
  @IsString()
  id!: string;

  @ApiProperty({ description: 'Node label (e.g. class or function name)' })
  @IsString()
  label!: string;

  @ApiPropertyOptional({ description: 'Node type (e.g. class, function)' })
  @IsOptional()
  @IsString()
  type?: string;

  @ApiPropertyOptional({ description: 'Source file path' })
  @IsOptional()
  @IsString()
  source_file?: string;

  @ApiPropertyOptional({ description: 'Community identifier' })
  @IsOptional()
  @IsString()
  community?: string;
}

export class GraphifyLinkDto {
  @ApiProperty({ description: 'Source node ID' })
  @IsString()
  source!: string;

  @ApiProperty({ description: 'Target node ID' })
  @IsString()
  target!: string;

  @ApiPropertyOptional({ description: 'Relation type (e.g. depends_on)' })
  @IsOptional()
  @IsString()
  relation?: string;
}

export class ImportGraphifyDto {
  @ApiProperty({
    description: 'Array of graph nodes to import',
    type: [GraphifyNodeDto],
  })
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => GraphifyNodeDto)
  nodes!: GraphifyNodeDto[];

  @ApiPropertyOptional({
    description: 'Array of graph links to import',
    type: [GraphifyLinkDto],
    required: false,
  })
  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => GraphifyLinkDto)
  links?: GraphifyLinkDto[];
}
