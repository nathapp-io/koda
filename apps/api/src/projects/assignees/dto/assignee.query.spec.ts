import { ValidationAppException } from '@nathapp/nestjs-common';
import {
  ASSIGNEE_LIMIT_DEFAULT,
  ASSIGNEE_QUERY_MAX_LENGTH,
  AssigneeQuery,
  RawAssigneeQuery,
} from './assignee.query';

/** Runs `parse` and returns whatever it threw (null when it did not throw). */
const errorOf = (raw: RawAssigneeQuery): unknown => {
  try {
    AssigneeQuery.parse(raw);
    return null;
  } catch (error) {
    return error;
  }
};

describe('AssigneeQuery', () => {
  it('defaults limit to 20 and q to "no filter"', () => {
    const query = AssigneeQuery.parse({});

    expect(query.limit).toBe(ASSIGNEE_LIMIT_DEFAULT);
    expect(query.q).toBe('');
  });

  it('keeps a limit inside 1..50 and converts a numeric string', () => {
    expect(AssigneeQuery.parse({ limit: '2' }).limit).toBe(2);
    expect(AssigneeQuery.parse({ limit: 50 }).limit).toBe(50);
    expect(AssigneeQuery.parse({ limit: 1 }).limit).toBe(1);
  });

  it('rejects limit 0, 51, a non-integer and a non-number with a 400', () => {
    for (const limit of [0, 51, 2.5]) {
      const error = errorOf({ limit: limit as unknown as number });

      expect(error).toBeInstanceOf(ValidationAppException);
      expect((error as ValidationAppException).httpStatus).toBe(400);
    }
  });

  it('trims q', () => {
    expect(AssigneeQuery.parse({ q: '  ALI  ' }).q).toBe('ALI');
  });

  it('accepts a q of exactly 100 characters and rejects 101 with a 400', () => {
    expect(AssigneeQuery.parse({ q: 'x'.repeat(ASSIGNEE_QUERY_MAX_LENGTH) }).q).toHaveLength(
      ASSIGNEE_QUERY_MAX_LENGTH,
    );

    const error = errorOf({ q: 'x'.repeat(ASSIGNEE_QUERY_MAX_LENGTH + 1) });

    expect(error).toBeInstanceOf(ValidationAppException);
    expect((error as ValidationAppException).httpStatus).toBe(400);
  });

  it('measures the length after trimming, so padding does not push a valid q over the limit', () => {
    expect(AssigneeQuery.parse({ q: `  ${'x'.repeat(ASSIGNEE_QUERY_MAX_LENGTH)}  ` }).q).toHaveLength(
      ASSIGNEE_QUERY_MAX_LENGTH,
    );
  });

  it('rejects a repeated (non-string) q with a 400', () => {
    const error = errorOf({ q: ['a', 'b'] as unknown as string });

    expect(error).toBeInstanceOf(ValidationAppException);
    expect((error as ValidationAppException).httpStatus).toBe(400);
  });
});
