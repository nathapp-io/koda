import { ApiProperty } from '@nestjs/swagger';
import { IsIn, IsObject, IsOptional, IsString, MinLength } from 'class-validator';

export class AddDocumentDto {
  @ApiProperty({ enum: ['ticket', 'doc', 'manual', 'code'], description: 'Source type' })
  @IsString()
  @IsIn(['ticket', 'doc', 'manual', 'code'])
  source!: 'ticket' | 'doc' | 'manual' | 'code';

  @ApiProperty({ description: 'Source record ID (e.g. ticket CUID)' })
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
