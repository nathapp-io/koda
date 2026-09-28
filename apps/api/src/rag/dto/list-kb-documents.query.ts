import { ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsInt, IsOptional, Max, Min } from 'class-validator';

export const KB_LIST_MAX_LIMIT = 500;

export class ListKbDocumentsQuery {
  @ApiPropertyOptional({ default: 100, minimum: 1, maximum: KB_LIST_MAX_LIMIT })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(KB_LIST_MAX_LIMIT)
  limit: number = 100;
}
