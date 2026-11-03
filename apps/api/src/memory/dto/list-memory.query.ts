import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsEnum, IsIn, IsOptional, IsString, Length } from 'class-validator';
import { KodaPageQuery } from '../../common/dto/koda-page.query';
import { MemoryKind } from '../../common/enums';

export const MEMORY_STATUSES = ['active', 'superseded', 'rejected'] as const;
export const MEMORY_ORDER_BY = ['confidence', 'updatedAt', 'createdAt'] as const;
/** The longest text the list route searches for, the same bound `koda_memory_search` advertises. */
export const MEMORY_TEXT_MAX_CHARS = 100;

export class ListMemoryQuery extends KodaPageQuery {
  @ApiPropertyOptional({ enum: MemoryKind })
  @IsOptional()
  @IsEnum(MemoryKind)
  kind?: MemoryKind;

  @ApiPropertyOptional({ description: 'Subject prefix' })
  @IsOptional()
  @IsString()
  subject?: string;

  /**
   * memory-notes US-003: a 1- to 100-character search. The repository ranks it by full text (English
   * stemming over subject, predicate, description and object) and falls back to a case-insensitive
   * substring when the text has no lexeme or matched nothing.
   */
  @ApiPropertyOptional({ description: 'Full-text search text (1-100 characters)', minLength: 1, maxLength: MEMORY_TEXT_MAX_CHARS })
  @IsOptional()
  @IsString()
  @Length(1, MEMORY_TEXT_MAX_CHARS)
  text?: string;

  @ApiPropertyOptional({ enum: MEMORY_STATUSES, description: 'Defaults to active, non-expired items' })
  @IsOptional()
  @IsIn(MEMORY_STATUSES)
  status?: (typeof MEMORY_STATUSES)[number];

  @ApiPropertyOptional({ enum: MEMORY_ORDER_BY, description: 'Defaults to rank when text is given, confidence otherwise' })
  @IsOptional()
  @IsIn(MEMORY_ORDER_BY)
  orderBy?: (typeof MEMORY_ORDER_BY)[number];
}
