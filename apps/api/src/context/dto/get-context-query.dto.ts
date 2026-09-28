import { ApiPropertyOptional } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import type { TransformFnParams } from 'class-transformer';
import { ArrayMaxSize, IsArray, IsBoolean, IsIn, IsInt, IsOptional, IsString, Max, MaxLength, Min } from 'class-validator';
import type { ContextIntent } from '../context-builder.service';

export const CONTEXT_INTENTS: readonly ContextIntent[] = ['answer', 'diagnose', 'plan', 'update', 'search'];

const MAX_LIST_ITEMS = 100;

/** Query strings carry `a,b` or a repeated key; a JSON body carries an array. */
const toStringList = ({ value }: TransformFnParams): unknown =>
  typeof value === 'string' ? value.split(',').map((s) => s.trim()).filter(Boolean) : value;

/** Query strings carry 'true'/'false'; anything else is left for @IsBoolean to reject. */
const toBoolean = ({ value }: TransformFnParams): unknown => {
  if (value === 'true') return true;
  if (value === 'false') return false;
  return value;
};

/**
 * GET /context/:slug query and POST /context/:slug/query body. The global
 * ValidationPipe validates it; controllers read it through parseQuery.
 */
export class GetContextQueryDto {
  @ApiPropertyOptional({ enum: CONTEXT_INTENTS, default: 'answer' })
  @IsOptional()
  @IsIn(CONTEXT_INTENTS)
  intent?: ContextIntent;

  @ApiPropertyOptional({ maxLength: 2000 })
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  query?: string;

  @ApiPropertyOptional({ type: [String], maxItems: MAX_LIST_ITEMS })
  @IsOptional()
  @Transform(toStringList)
  @IsArray()
  @ArrayMaxSize(MAX_LIST_ITEMS)
  @IsString({ each: true })
  @MaxLength(200, { each: true })
  ticketIds?: string[];

  @ApiPropertyOptional({ type: [String], maxItems: MAX_LIST_ITEMS })
  @IsOptional()
  @Transform(toStringList)
  @IsArray()
  @ArrayMaxSize(MAX_LIST_ITEMS)
  @IsString({ each: true })
  @MaxLength(200, { each: true })
  repoRefs?: string[];

  @ApiPropertyOptional()
  @IsOptional()
  @Transform(toBoolean)
  @IsBoolean()
  includeCodeIntel?: boolean;

  @ApiPropertyOptional()
  @IsOptional()
  @Transform(toBoolean)
  @IsBoolean()
  includeGraph?: boolean;

  @ApiPropertyOptional({ minimum: 1, maximum: 100_000 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100_000)
  tokenBudget?: number;
}
