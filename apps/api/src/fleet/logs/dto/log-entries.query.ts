import { ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsIn, IsInt, IsOptional, IsString, Max, MaxLength, Min } from 'class-validator';
import { LOG_LEVELS, LogLevel } from '../log-entry';

export const ENTRIES_DEFAULT_LIMIT = 200;
export const ENTRIES_MAX_LIMIT = 500;

/** Spec §3.3 query. Pass through `parseQuery` for numbers (the global pipe does not transform). */
export class LogEntriesQuery {
  @ApiPropertyOptional({ minimum: 0, description: "Attempt; defaults to the job's current leaseEpoch (D332)" })
  @IsOptional() @Type(() => Number) @IsInt() @Min(0) leaseEpoch?: number;

  @ApiPropertyOptional({ minimum: 0, description: 'A nextCursor from an earlier page; forward default 0, backward default the visible end' })
  @IsOptional() @Type(() => Number) @IsInt() @Min(0) cursor?: number;

  @ApiPropertyOptional({ enum: ['forward', 'backward'], default: 'forward' })
  @IsOptional() @IsIn(['forward', 'backward']) direction?: 'forward' | 'backward';

  @ApiPropertyOptional({ minimum: 1, maximum: ENTRIES_MAX_LIMIT, default: ENTRIES_DEFAULT_LIMIT })
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(ENTRIES_MAX_LIMIT) limit?: number;

  @ApiPropertyOptional({ enum: LOG_LEVELS, description: 'Minimum level (run stream)' })
  @IsOptional() @IsIn([...LOG_LEVELS]) level?: LogLevel;

  @ApiPropertyOptional({ description: 'Exact story id (run stream)' }) @IsOptional() @IsString() @MaxLength(128) storyId?: string;
  @ApiPropertyOptional({ description: 'Exact stage (run stream)' }) @IsOptional() @IsString() @MaxLength(128) stage?: string;
  @ApiPropertyOptional({ description: 'Exact nax sessionRole (run stream)' }) @IsOptional() @IsString() @MaxLength(128) role?: string;
  @ApiPropertyOptional({ description: 'Case-insensitive substring of the raw line' }) @IsOptional() @IsString() @MaxLength(256) q?: string;
}
