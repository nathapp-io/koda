import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsIn, IsInt, IsISO8601, IsOptional, IsString, Matches, Max, MaxLength, Min } from 'class-validator';
import {
  ADMIN_GROUPS, ANALYTICS_LIMITS, Bucket, BUCKETS, GroupBy, JOB_SORTS, JobSort, PROJECT_GROUPS, ProjectGroupBy, STORY_SORTS, StorySort,
} from '../domain/analytics.domain';

/**
 * A date (UTC midnight) or an instant ending in Z. An offset-less datetime would parse in the server's local zone,
 * and `+hh:mm` loses its `+` in a query string, so only these two forms are accepted.
 */
const UTC_INSTANT = /^\d{4}-\d{2}-\d{2}(T[0-9:.]+Z)?$/;
const UTC_MESSAGE = { message: 'use a date (YYYY-MM-DD) or a UTC instant ending in Z' };

/** Spec §4.1. Pass through `parseQuery` (the global pipe validates but does not transform). */
export class AnalyticsRangeQuery {
  @ApiPropertyOptional({ format: 'date-time', description: 'Window start, inclusive (UTC date or instant ending in Z); default `to` minus 30 days' })
  @IsOptional() @IsISO8601({ strict: true }) @Matches(UTC_INSTANT, UTC_MESSAGE) from?: string;

  @ApiPropertyOptional({ format: 'date-time', description: 'Window end, exclusive (UTC date or instant ending in Z); default now. At most 366 days after `from`' })
  @IsOptional() @IsISO8601({ strict: true }) @Matches(UTC_INSTANT, UTC_MESSAGE) to?: string;
}

export class AnalyticsBucketQuery extends AnalyticsRangeQuery {
  @ApiPropertyOptional({ enum: BUCKETS, description: 'Default from the window: <= 31 days day, <= 182 days week, else month' })
  @IsOptional() @IsIn([...BUCKETS]) bucket?: Bucket;
}

export class SpendQuery extends AnalyticsBucketQuery {
  @ApiPropertyOptional({ enum: PROJECT_GROUPS, default: 'model' })
  @IsOptional() @IsIn([...PROJECT_GROUPS]) groupBy?: ProjectGroupBy;
}

export class AdminSpendQuery extends AnalyticsBucketQuery {
  @ApiPropertyOptional({ enum: ADMIN_GROUPS, default: 'model' })
  @IsOptional() @IsIn([...ADMIN_GROUPS]) groupBy?: GroupBy;
}

export class StoriesQuery extends AnalyticsRangeQuery {
  @ApiPropertyOptional({ enum: STORY_SORTS, default: 'cost' })
  @IsOptional() @IsIn([...STORY_SORTS]) sort?: StorySort;

  @ApiPropertyOptional({ minimum: 1, maximum: ANALYTICS_LIMITS.listMax, default: ANALYTICS_LIMITS.listDefault })
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(ANALYTICS_LIMITS.listMax) limit?: number;
}

export class JobsQuery extends AnalyticsRangeQuery {
  @ApiPropertyOptional({ enum: JOB_SORTS, default: 'cost' })
  @IsOptional() @IsIn([...JOB_SORTS]) sort?: JobSort;

  @ApiPropertyOptional({ minimum: 1, maximum: ANALYTICS_LIMITS.listMax, default: ANALYTICS_LIMITS.listDefault })
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(ANALYTICS_LIMITS.listMax) limit?: number;
}

/** Spec §4.3, D384. */
export class DeleteAnalyticsQuery {
  @ApiProperty({ format: 'date-time', description: 'Delete rows dated before this instant (UTC date or instant ending in Z)' })
  @IsISO8601({ strict: true }) @Matches(UTC_INSTANT, UTC_MESSAGE) before: string;

  @ApiPropertyOptional({ description: 'Only this project; omit for every project' })
  @IsOptional() @IsString() @MaxLength(64) projectId?: string;
}

export class DeleteAnalyticsBody {
  @ApiProperty({ description: "The project's slug, or ALL when no projectId is given" })
  @IsString() @MaxLength(200) confirm: string;
}
