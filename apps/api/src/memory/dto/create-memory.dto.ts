import { ApiProperty } from '@nestjs/swagger';
import { IsIn, IsNumber, IsOptional, IsString, Max, MaxLength, Min, MinLength } from 'class-validator';
import { MemoryKind, MemoryScope } from '../../common/enums';
import { MEMORY_NOTE_DESCRIPTION_MAX_CHARS } from '../memory-note';

const MEMORY_KINDS = Object.values(MemoryKind);
const MEMORY_SCOPES = Object.values(MemoryScope);

export class CreateMemoryDto {
  @ApiProperty({ description: 'Project ID the memory item belongs to' })
  @IsString()
  @MinLength(1)
  projectId!: string;

  @ApiProperty({ enum: MEMORY_SCOPES, required: false, description: 'Whose memory the item is: "project" (default) stores it in the named project, "user" stores it once for the caller, which only a NOTE may be' })
  @IsOptional()
  @IsIn(MEMORY_SCOPES)
  scope?: MemoryScope;

  @ApiProperty({ enum: MEMORY_KINDS, description: 'Kind of memory item' })
  @IsString()
  @IsIn(MEMORY_KINDS)
  kind!: MemoryKind;

  @ApiProperty({ description: 'Subject of the fact/decision/preference/constraint (e.g. a ticket ID, a topic)' })
  @IsString()
  @MinLength(1)
  subject!: string;

  @ApiProperty({ description: 'Predicate — the relationship or statement being made about the subject' })
  @IsString()
  @MinLength(1)
  predicate!: string;

  @ApiProperty({ required: false, description: 'Object — the value/target of the predicate' })
  @IsOptional()
  @IsString()
  object?: string;

  @ApiProperty({
    required: false,
    maxLength: MEMORY_NOTE_DESCRIPTION_MAX_CHARS,
    description: 'Index line of a NOTE memory item (required for kind NOTE, rejected for every other kind)',
  })
  @IsOptional()
  @IsString()
  @MaxLength(MEMORY_NOTE_DESCRIPTION_MAX_CHARS)
  description?: string;

  @ApiProperty({ required: false, description: 'Where this memory item came from (defaults to "manual")' })
  @IsOptional()
  @IsString()
  sourceType?: string;

  @ApiProperty({ required: false, description: 'ID of the source record this memory item came from' })
  @IsOptional()
  @IsString()
  sourceId?: string;

  @ApiProperty({ required: false, description: 'Confidence score between 0 and 1 (defaults to 0.8)' })
  @IsOptional()
  @IsNumber()
  @Min(0)
  @Max(1)
  confidence?: number;

  @ApiProperty({ required: false, description: 'ID of the user/agent who owns this memory item. Only honored for global admin callers — every other caller always owns the item themselves, regardless of this value.' })
  @IsOptional()
  @IsString()
  ownerId?: string;
}
