import { DEFAULT_THROTTLE_LIMIT, globalThrottleLimit } from './throttle-limit';

describe('globalThrottleLimit (default throttler)', () => {
  it('is 100/min when THROTTLE_LIMIT is unset', () => {
    expect(globalThrottleLimit({})).toBe(100);
    expect(DEFAULT_THROTTLE_LIMIT).toBe(100);
  });

  it('honours a positive integer THROTTLE_LIMIT (e2e raises it: one client IP for every spec)', () => {
    expect(globalThrottleLimit({ THROTTLE_LIMIT: '1000' })).toBe(1000);
  });

  it.each(['0', '-5', 'abc', ''])('falls back to the default for %p', (value) => {
    expect(globalThrottleLimit({ THROTTLE_LIMIT: value })).toBe(100);
  });
});
