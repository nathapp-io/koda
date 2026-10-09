import { ApiPropertyOptional } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import { IsInt, IsOptional, IsString, Max, MaxLength, Min } from 'class-validator';
import { ValidationAppException } from '@nathapp/nestjs-common';

/** Longest accepted `q` (S4c US-004 §3.3). */
export const ASSIGNEE_QUERY_MAX_LENGTH = 100;
/** Assignees returned when `limit` is not given. */
export const ASSIGNEE_LIMIT_DEFAULT = 20;
/** Largest accepted `limit`; it caps the combined user + agent list. */
export const ASSIGNEE_LIMIT_MAX = 50;

/** The raw query as it arrives from the URL: both values are strings, or absent. */
export interface RawAssigneeQuery {
  q?: unknown;
  limit?: unknown;
}

/**
 * S4c US-004: the assignee typeahead parameters. The global ValidationPipe does
 * not transform, so `parse` normalizes and re-validates the raw query and
 * refuses anything outside the contract with a 400 (its decorators also keep
 * the pipe's `whitelist: true` from stripping the two fields).
 */
export class AssigneeQuery {
  @ApiPropertyOptional({
    description: 'Case-insensitive substring of a name, email or slug',
    maxLength: ASSIGNEE_QUERY_MAX_LENGTH,
  })
  @IsOptional()
  @IsString()
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  @MaxLength(ASSIGNEE_QUERY_MAX_LENGTH)
  q: string = '';

  @ApiPropertyOptional({
    description: 'Maximum combined number of assignees',
    default: ASSIGNEE_LIMIT_DEFAULT,
    minimum: 1,
    maximum: ASSIGNEE_LIMIT_MAX,
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(ASSIGNEE_LIMIT_MAX)
  limit: number = ASSIGNEE_LIMIT_DEFAULT;

  static parse(raw: RawAssigneeQuery = {}): AssigneeQuery {
    const query = new AssigneeQuery();
    query.q = AssigneeQuery.normalizeQ(raw.q);
    query.limit = AssigneeQuery.normalizeLimit(raw.limit);
    return query;
  }

  private static normalizeQ(raw: unknown): string {
    if (raw === undefined || raw === null) return '';
    if (typeof raw !== 'string') {
      throw new ValidationAppException({ q: 'q must be a string' }, 'tickets');
    }
    const q = raw.trim();
    if (q.length > ASSIGNEE_QUERY_MAX_LENGTH) {
      throw new ValidationAppException(
        { q: `q must be at most ${ASSIGNEE_QUERY_MAX_LENGTH} characters` },
        'tickets',
      );
    }
    return q;
  }

  private static normalizeLimit(raw: unknown): number {
    if (raw === undefined || raw === null) return ASSIGNEE_LIMIT_DEFAULT;
    const limit = typeof raw === 'number' ? raw : typeof raw === 'string' ? Number(raw) : Number.NaN;
    if (!Number.isInteger(limit) || limit < 1 || limit > ASSIGNEE_LIMIT_MAX) {
      throw new ValidationAppException(
        { limit: `limit must be an integer between 1 and ${ASSIGNEE_LIMIT_MAX}` },
        'tickets',
      );
    }
    return limit;
  }
}
