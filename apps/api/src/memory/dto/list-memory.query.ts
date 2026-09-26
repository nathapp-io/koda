import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsEnum, IsIn, IsOptional, IsString } from 'class-validator';
import { KodaPageQuery } from '../../common/dto/koda-page.query';
import { MemoryKind } from '../../common/enums';

export const MEMORY_STATUSES = ['active', 'superseded', 'rejected'] as const;
export const MEMORY_ORDER_BY = ['confidence', 'updatedAt', 'createdAt'] as const;

export class ListMemoryQuery extends KodaPageQuery {
  @ApiPropertyOptional({ enum: MemoryKind })
  @IsOptional()
  @IsEnum(MemoryKind)
  kind?: MemoryKind;

  @ApiPropertyOptional({ description: 'Subject prefix' })
  @IsOptional()
  @IsString()
  subject?: string;

  @ApiPropertyOptional({ enum: MEMORY_STATUSES, description: 'Defaults to active, non-expired items' })
  @IsOptional()
  @IsIn(MEMORY_STATUSES)
  status?: (typeof MEMORY_STATUSES)[number];

  @ApiPropertyOptional({ enum: MEMORY_ORDER_BY, default: 'confidence' })
  @IsOptional()
  @IsIn(MEMORY_ORDER_BY)
  orderBy?: (typeof MEMORY_ORDER_BY)[number];
}
