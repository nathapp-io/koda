import { emailConfig } from './email.config';

const KEYS = ['SMTP_URL', 'EMAIL_FROM', 'WEB_PUBLIC_URL', 'EMAIL_DELAY_SEC', 'EMAIL_APPROVAL_DELAY_SEC', 'EMAIL_MAX_ATTEMPTS', 'INVITE_TTL_DAYS'];

const withEnv = (env: Record<string, string | undefined>) => {
  const saved = { ...process.env };
  for (const k of KEYS) delete process.env[k];
  for (const [k, v] of Object.entries(env)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  try {
    return emailConfig();
  } finally {
    process.env = saved;
  }
};

describe('emailConfig (S4b §1)', () => {
  it('is off with defaults when SMTP_URL is unset', () => {
    expect(withEnv({})).toEqual({
      smtpUrl: null, from: null, webPublicUrl: null, delaySec: 300, approvalDelaySec: 60, maxAttempts: 5, inviteTtlDays: 7,
    });
  });

  it('requires EMAIL_FROM and WEB_PUBLIC_URL when SMTP_URL is set', () => {
    expect(() => withEnv({ SMTP_URL: 'smtp://u:p@h:25', WEB_PUBLIC_URL: 'https://k.x' })).toThrow(/EMAIL_FROM/);
    expect(() => withEnv({ SMTP_URL: 'smtp://u:p@h:25', EMAIL_FROM: 'k@x' })).toThrow(/WEB_PUBLIC_URL/);
  });

  it('strips one trailing slash from WEB_PUBLIC_URL (Review Focus 2)', () => {
    expect(withEnv({ SMTP_URL: 'smtp://h', EMAIL_FROM: 'k@x', WEB_PUBLIC_URL: 'https://koda.x/' }).webPublicUrl).toBe('https://koda.x');
  });

  it('rejects a non-http WEB_PUBLIC_URL and out-of-range numbers', () => {
    expect(() => withEnv({ SMTP_URL: 'smtp://h', EMAIL_FROM: 'k@x', WEB_PUBLIC_URL: 'koda.x' })).toThrow(/WEB_PUBLIC_URL/);
    expect(() => withEnv({ INVITE_TTL_DAYS: '31' })).toThrow(/INVITE_TTL_DAYS/);
    expect(() => withEnv({ EMAIL_MAX_ATTEMPTS: '0' })).toThrow(/EMAIL_MAX_ATTEMPTS/);
    expect(() => withEnv({ EMAIL_DELAY_SEC: '1e3' })).toThrow(/EMAIL_DELAY_SEC/);
  });

  it('never puts SMTP_URL in an error message', () => {
    expect(() => withEnv({ SMTP_URL: 'smtp://user:s3cret@h', WEB_PUBLIC_URL: 'https://k.x' })).toThrow(/^(?!.*s3cret).*$/);
  });
});
