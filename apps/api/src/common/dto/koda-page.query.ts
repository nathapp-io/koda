import { ApiPropertyOptional } from '@nestjs/swagger';
import { Type, plainToInstance } from 'class-transformer';
import { IsInt, IsOptional, Max, Min } from 'class-validator';
import { PageOption } from '@nathapp/nestjs-common';
import type { IPageResult } from '@nathapp/nestjs-data';

export const KODA_PAGE_MAX_SIZE = 100;

/**
 * Shared list query: 1-based `current`, `size` 1..100 (default 20).
 * The global ValidationPipe does not transform, so controllers must pass the
 * raw query through `parseQuery` to get numbers and defaults.
 */
export class KodaPageQuery extends PageOption {
  @ApiPropertyOptional({ description: 'Page number (1-based)', default: 1, minimum: 1 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  current: number = 1;

  @ApiPropertyOptional({ description: 'Page size', default: 20, minimum: 1, maximum: KODA_PAGE_MAX_SIZE })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(KODA_PAGE_MAX_SIZE)
  size: number = 20;
}

export function parseQuery<T extends object>(cls: new () => T, raw: object): T {
  return plainToInstance(cls, raw);
}

/** A Page instance carries transformOptions/extra; send only the envelope. */
export function toPageResult<T>(page: IPageResult<T>): IPageResult<T> {
  const { total, current, size, hasNext, hasPrev, records } = page;
  return { total, current, size, hasNext, hasPrev, records };
}

/** Map a page's records without depending on the concrete Page class. */
export function remapPage<S, T>(page: IPageResult<S>, fn: (item: S) => T): IPageResult<T> {
  return { ...toPageResult(page), records: page.records.map(fn) };
}
