import { RunnerApiController } from './runner-api.controller';

const LIMIT_KEY = 'THROTTLER:LIMITdefault';
const TTL_KEY = 'THROTTLER:TTLdefault';

/** The @Throttle metadata a handler captured at class-load time. */
function captured(handler: 'enroll'): { limit: unknown; ttl: unknown } {
  const proto = RunnerApiController.prototype as unknown as Record<string, unknown>;
  const fn = proto[handler] as object;
  return { limit: Reflect.getMetadata(LIMIT_KEY, fn), ttl: Reflect.getMetadata(TTL_KEY, fn) };
}

/** Re-imports the controller with the env in place, so the limit is captured again. */
async function withEnv(value: string | undefined): Promise<{ limit: unknown; ttl: unknown }> {
  const previous = process.env['FLEET_ENROLL_THROTTLE_LIMIT'];
  if (value === undefined) delete process.env['FLEET_ENROLL_THROTTLE_LIMIT'];
  else process.env['FLEET_ENROLL_THROTTLE_LIMIT'] = value;
  try {
    vi.resetModules();
    const { RunnerApiController: reloaded } = await import('./runner-api.controller');
    const proto = reloaded.prototype as unknown as Record<string, unknown>;
    const fn = proto['enroll'] as object;
    return { limit: Reflect.getMetadata(LIMIT_KEY, fn), ttl: Reflect.getMetadata(TTL_KEY, fn) };
  } finally {
    if (previous === undefined) delete process.env['FLEET_ENROLL_THROTTLE_LIMIT'];
    else process.env['FLEET_ENROLL_THROTTLE_LIMIT'] = previous;
  }
}

describe('runner enrollment throttle', () => {
  it('keeps the production default of 10/min when FLEET_ENROLL_THROTTLE_LIMIT is unset', async () => {
    const { limit, ttl } = await withEnv(undefined);
    expect(limit).toBe(10);
    expect(ttl).toBe(60_000);
  });

  it('honours FLEET_ENROLL_THROTTLE_LIMIT at class load time (the e2e run raises it)', async () => {
    const { limit, ttl } = await withEnv('1000');
    expect(limit).toBe(1000);
    expect(ttl).toBe(60_000);
  });

  it.each(['0', '-5', 'abc', ''])('falls back to the default for %p', async (value) => {
    const { limit } = await withEnv(value);
    expect(limit).toBe(10);
  });

  it('is captured on the enroll handler, not on the whole controller', () => {
    expect(captured('enroll').limit).toBe(10);
    expect(Reflect.getMetadata(LIMIT_KEY, RunnerApiController)).toBeUndefined();
  });
});
