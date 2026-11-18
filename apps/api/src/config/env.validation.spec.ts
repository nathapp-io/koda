import { validate } from './env.validation';

const REQUIRED = {
  DATABASE_URL: 'postgresql://u:p@localhost:5432/db',
  JWT_SECRET: 'j'.repeat(32),
  JWT_REFRESH_SECRET: 'r'.repeat(32),
  API_KEY_SECRET: 'k'.repeat(32),
};

/** 31 characters: one short of the production floor (review US-004). */
const ONE_SHORT = 'x'.repeat(31);

describe('env validation', () => {
  it('does not inject a DATABASE_PROVIDER default', () => {
    const out = validate({ ...REQUIRED });
    expect(out).not.toHaveProperty('DATABASE_PROVIDER');
  });

  it('still requires DATABASE_URL', () => {
    const { DATABASE_URL: _omit, ...withoutUrl } = REQUIRED;
    expect(() => validate(withoutUrl)).toThrow();
  });

  it('rejects LIVE_HEARTBEAT_MS below 100 and accepts 100', () => {
    expect(() => validate({ ...REQUIRED, LIVE_HEARTBEAT_MS: '99' })).toThrow();
    expect(() => validate({ ...REQUIRED, LIVE_HEARTBEAT_MS: '100' })).not.toThrow();
  });

  it('rejects non-digit heartbeat values Joi.number() would coerce', () => {
    expect(() => validate({ ...REQUIRED, LIVE_HEARTBEAT_MS: '1e3' })).toThrow();
    expect(() => validate({ ...REQUIRED, LIVE_HEARTBEAT_MS: '100.0' })).toThrow();
  });

  it('rejects out-of-range PR review polling and dispatch settings', () => {
    expect(() => validate({ ...REQUIRED, FLEET_PR_REVIEW_POLL_MS: '59999' })).toThrow();
    expect(() => validate({ ...REQUIRED, FLEET_PR_REVIEW_MAX_DISPATCH: '0' })).toThrow();
  });

  describe('placeholder secrets (review E/SEC-3)', () => {
    const PLACEHOLDER_KEYS = ['JWT_SECRET', 'JWT_REFRESH_SECRET', 'API_KEY_SECRET'] as const;

    it.each(PLACEHOLDER_KEYS)('rejects a change-me %s when ENV_NAME is production', (key) => {
      expect(() =>
        validate({ ...REQUIRED, ENV_NAME: 'production', [key]: 'change-me-in-production-placeholder-secret' }),
      ).toThrow(key);
    });

    it.each(PLACEHOLDER_KEYS)('rejects a change-me %s when NODE_ENV is production', (key) => {
      expect(() => validate({ ...REQUIRED, NODE_ENV: 'production', [key]: 'change-me-secret-that-is-long-enough' })).toThrow(
        key,
      );
    });

    it('rejects the placeholder regardless of case', () => {
      expect(() =>
        validate({ ...REQUIRED, ENV_NAME: 'production', JWT_SECRET: 'CHANGE-ME-SECRET-THAT-IS-LONG-ENOUGH' }),
      ).toThrow('JWT_SECRET');
    });

    it('accepts real secrets in production', () => {
      expect(() => validate({ ...REQUIRED, ENV_NAME: 'production' })).not.toThrow();
    });

    it('accepts a change-me secret outside production (dev compose defaults)', () => {
      expect(() => validate({ ...REQUIRED, JWT_SECRET: 'change-me-dev', JWT_REFRESH_SECRET: 'change-me-dev-refresh' })).not.toThrow();
    });
  });

  describe('secret length floor (review US-004)', () => {
    const KEYS = ['JWT_SECRET', 'JWT_REFRESH_SECRET', 'API_KEY_SECRET'] as const;

    it.each(KEYS)('rejects a 31-character %s when NODE_ENV is production', (key) => {
      expect(() => validate({ ...REQUIRED, NODE_ENV: 'production', [key]: ONE_SHORT })).toThrow(key);
    });

    it('rejects a 31-character JWT_SECRET when ENV_NAME is production (Dockerfile path)', () => {
      expect(() => validate({ ...REQUIRED, ENV_NAME: 'production', JWT_SECRET: ONE_SHORT })).toThrow('JWT_SECRET');
    });

    it('accepts three distinct 32-character secrets in production', () => {
      expect(() => validate({ ...REQUIRED, NODE_ENV: 'production' })).not.toThrow();
    });

    it('accepts one-character secrets outside production (dev and test)', () => {
      const short = { ...REQUIRED, NODE_ENV: 'test', JWT_SECRET: 'a', JWT_REFRESH_SECRET: 'b', API_KEY_SECRET: 'c' };
      expect(() => validate(short)).not.toThrow();
    });

    it('never echoes the secret value in the length error', () => {
      const value = 'Zq7-tell-tale-value'.padEnd(31, 'Z');
      let message = '';
      try {
        validate({ ...REQUIRED, NODE_ENV: 'production', JWT_SECRET: value });
      } catch (error) {
        message = error instanceof Error ? error.message : String(error);
      }

      expect(message).toContain('JWT_SECRET');
      expect(message).not.toContain(value);
      expect(message).not.toContain('Zq7-tell-tale-value');
    });
  });

  it('accepts empty SMTP_URL / EMAIL_FROM / WEB_PUBLIC_URL as "email off" (S4b review I1)', () => {
    expect(() => validate({ ...REQUIRED, SMTP_URL: '', EMAIL_FROM: '', WEB_PUBLIC_URL: '' })).not.toThrow();
  });
});
