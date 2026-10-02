import { assertCronAllowed, canonicalTimezone, CronInputError, nextFireAfter, normalizeCron, walkFires } from './cron-schedule';

const at = (iso: string): Date => new Date(iso);
const failure = (fn: () => unknown): string | null => {
  try {
    fn();
    return null;
  } catch (error) {
    return error instanceof CronInputError ? error.failure : 'other';
  }
};
/** The next `count` fires after `from`, each computed from the previous one (what the ticker does). */
const fires = (cron: string, timezone: string, from: string, count: number): string[] => {
  const out: string[] = [];
  let cursor = at(from);
  for (let i = 0; i < count; i += 1) {
    cursor = nextFireAfter(cron, timezone, cursor);
    out.push(cursor.toISOString());
  }
  return out;
};

describe('normalizeCron', () => {
  it('collapses whitespace and keeps five fields', () => {
    expect(normalizeCron('  0   9 * *  1-5 ')).toBe('0 9 * * 1-5');
  });

  it.each(['* * * *', '* * * * * *', '@daily', '', '   '])('rejects %p (not exactly five fields)', (expression) => {
    expect(failure(() => normalizeCron(expression))).toBe('syntax');
  });

  it.each(['0 9 ? * *', '0 9 L * *', '0 9 15W * *', '0 9 * * 5#2', '0 9 * * 5L', '0 9 * * foo'])('rejects the non-standard token in %p', (expression) => {
    expect(failure(() => normalizeCron(expression))).toBe('syntax');
  });

  it.each(['0 9 * * MON-FRI', '0 9 1 JAN *', '0 9 * * wed', '0 9 1 jul *'])('keeps the standard day and month names in %p', (expression) => {
    expect(normalizeCron(expression)).toBe(expression);
    expect(nextFireAfter(expression, 'UTC', at('2026-10-02T00:00:00.000Z')).getTime()).toBeGreaterThan(at('2026-10-02T00:00:00.000Z').getTime());
  });
});

describe('canonicalTimezone', () => {
  it('canonicalises the case of an IANA name', () => {
    expect(canonicalTimezone('asia/singapore')).toBe('Asia/Singapore');
    expect(canonicalTimezone('UTC')).toBe('UTC');
  });

  it.each(['', 'Mars/Base', 'Not a zone'])('rejects %p', (zone) => {
    expect(failure(() => canonicalTimezone(zone))).toBe('timezone');
  });

  it.each(['+08:00', '-05:00', '+0800'])('rejects the fixed offset %p: it is not an IANA zone (plan D191)', (zone) => {
    expect(failure(() => canonicalTimezone(zone))).toBe('timezone');
  });

  it('stores an alias under its canonical name (plan D191)', () => {
    expect(canonicalTimezone('EST')).toBe('America/Panama');
    expect(canonicalTimezone('US/Eastern')).toBe('America/New_York');
    expect(canonicalTimezone('Etc/GMT-8')).toBe('Etc/GMT-8');
  });
});

describe('nextFireAfter', () => {
  it('is strictly after the given instant', () => {
    expect(nextFireAfter('0 9 * * *', 'Asia/Singapore', at('2026-10-02T01:00:00.000Z')).toISOString()).toBe('2026-10-03T01:00:00.000Z');
    expect(nextFireAfter('0 9 * * *', 'Asia/Singapore', at('2026-10-02T00:59:59.999Z')).toISOString()).toBe('2026-10-02T01:00:00.000Z');
  });

  it('reads the cron in its own zone, whatever zone the process runs in', () => {
    expect(nextFireAfter('30 8 * * *', 'Asia/Singapore', at('2026-10-02T00:00:00.000Z')).toISOString()).toBe('2026-10-02T00:30:00.000Z');
    expect(nextFireAfter('30 8 * * *', 'UTC', at('2026-10-02T00:00:00.000Z')).toISOString()).toBe('2026-10-02T08:30:00.000Z');
  });

  it('fires a nonexistent local time once, shifted past the gap (spring forward, New York)', () => {
    expect(fires('30 2 * * *', 'America/New_York', '2026-03-07T12:00:00.000Z', 3)).toEqual([
      '2026-03-08T07:30:00.000Z', // 03:30 EDT: 02:30 does not exist on 8 March
      '2026-03-09T06:30:00.000Z', // 02:30 EDT
      '2026-03-10T06:30:00.000Z',
    ]);
  });

  it('fires an ambiguous local time once (fall back, New York)', () => {
    expect(fires('30 1 * * *', 'America/New_York', '2026-10-30T12:00:00.000Z', 3)).toEqual([
      '2026-10-31T05:30:00.000Z',
      '2026-11-01T05:30:00.000Z', // 01:30 EDT, the first of the two 01:30s on 1 November
      '2026-11-02T06:30:00.000Z', // 01:30 EST
    ]);
  });

  it('ORs day-of-month with day-of-week, as Vixie cron does', () => {
    expect(fires('0 9 13 * 5', 'UTC', '2026-10-02T00:00:00.000Z', 4)).toEqual([
      '2026-10-02T09:00:00.000Z',
      '2026-10-09T09:00:00.000Z',
      '2026-10-13T09:00:00.000Z',
      '2026-10-16T09:00:00.000Z',
    ]);
  });
});

describe('assertCronAllowed', () => {
  const NOW = at('2026-10-02T03:00:30.000Z');

  it.each(['*/15 * * * *', '0 * * * *', '0 9 * * 1-5', '30 8 1 * *'])('accepts %p', (expression) => {
    expect(assertCronAllowed(expression, 'UTC', NOW)).toEqual({ cron: expression, timezone: 'UTC' });
  });

  it('returns the normalised expression and the canonical zone', () => {
    expect(assertCronAllowed(' 0  9 * * * ', 'asia/singapore', NOW)).toEqual({ cron: '0 9 * * *', timezone: 'Asia/Singapore' });
  });

  it.each(['* * * * *', '*/10 * * * *', '0,10 * * * *', '0,5 0 1 * *'])('refuses %p: two fires closer than 15 minutes', (expression) => {
    expect(failure(() => assertCronAllowed(expression, 'UTC', NOW))).toBe('too_frequent');
  });

  it.each(['61 * * * *', '0 0 30 2 *', 'abc * * * *', '* * * *', '0 9 ? * *', '0 9 L * *'])('refuses %p as a syntax error', (expression) => {
    expect(failure(() => assertCronAllowed(expression, 'UTC', NOW))).toBe('syntax');
  });

  it('refuses a fixed-offset zone', () => {
    expect(failure(() => assertCronAllowed('0 * * * *', '+08:00', NOW))).toBe('timezone');
  });

  it('bounds the gap walk: a 4-year cron stops at the 2-year horizon, a frequent one at 100 fires (plan D191)', () => {
    expect(walkFires('0 0 29 2 *', 'UTC', NOW).length).toBeLessThanOrEqual(2);
    expect(assertCronAllowed('0 0 29 2 *', 'UTC', NOW)).toEqual({ cron: '0 0 29 2 *', timezone: 'UTC' });
    expect(walkFires('*/15 * * * *', 'UTC', NOW)).toHaveLength(100);
    expect(walkFires('0 9 * * *', 'UTC', NOW)).toHaveLength(100);
  });

  it('still catches a short gap inside the horizon of a rare cron', () => {
    expect(failure(() => assertCronAllowed('0,5 0 29 2 *', 'UTC', NOW))).toBe('too_frequent');
  });

  it('refuses an unknown zone', () => {
    expect(failure(() => assertCronAllowed('0 * * * *', 'Mars/Base', NOW))).toBe('timezone');
  });
});
