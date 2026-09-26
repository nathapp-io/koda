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

/**
 * Property names declared on the DTO class: own keys of a fresh instance
 * (field initializers, and declared-but-uninitialized fields under
 * useDefineForClassFields) plus everything on the prototype chain
 * (inherited declared fields, getters, methods) up to Object.prototype.
 */
function declaredPropertyNames<T extends object>(cls: new () => T): Set<string> {
  const names = new Set<string>(Object.keys(new cls()));
  let proto: object | null = cls.prototype;
  while (proto && proto !== Object.prototype) {
    for (const name of Object.getOwnPropertyNames(proto)) {
      if (name !== 'constructor') {
        names.add(name);
      }
    }
    proto = Object.getPrototypeOf(proto);
  }
  return names;
}

/**
 * Transform a raw query into a DTO instance with numbers/defaults applied.
 * Unlike bare `plainToInstance`, undeclared keys from the raw object are
 * stripped, so a query param cannot smuggle an undeclared field (e.g.
 * `?projectId=...` overriding a controller-resolved value) into the result.
 */
export function parseQuery<T extends object>(cls: new () => T, raw: object): T {
  const instance = plainToInstance(cls, raw);
  const declared = declaredPropertyNames(cls);
  for (const name of Object.keys(instance)) {
    if (!declared.has(name)) {
      delete (instance as Record<string, unknown>)[name];
    }
  }
  return instance;
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
