import { ApiProperty } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  IsArray,
  IsOptional,
  IsString,
  ValidateNested,
} from 'class-validator';

export class GraphifyNodeDto {
  @ApiProperty({ description: 'Unique identifier for this node' })
  @IsString()
  id!: string;

  @ApiProperty({ description: 'Display label for the node' })
  @IsString()
  label!: string;

  @ApiProperty({ required: false, description: 'Node type (e.g. class, function)' })
  @IsOptional()
  @IsString()
  type?: string;

  @ApiProperty({ required: false, description: 'Source file path' })
  @IsOptional()
  @IsString()
  source_file?: string;
}

export class GraphifyLinkDto {
  @ApiProperty({ description: 'Source node id' })
  @IsString()
  source!: string;

  @ApiProperty({ description: 'Target node id' })
  @IsString()
  target!: string;

  @ApiProperty({ description: 'Relation type (e.g. depends_on, calls)' })
  @IsString()
  relation!: string;
}

export class ImportGraphifyDto {
  @ApiProperty({ type: [GraphifyNodeDto], description: 'Graph nodes to import' })
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => GraphifyNodeDto)
  nodes!: GraphifyNodeDto[];

  @ApiProperty({ type: [GraphifyLinkDto], required: false, description: 'Graph links to import' })
  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => GraphifyLinkDto)
  links?: GraphifyLinkDto[];
}
