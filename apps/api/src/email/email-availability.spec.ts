import { EmailAvailability } from './email-availability';

const cfg = (over = {}) => ({
  smtpUrl: 'smtp://h', from: 'k@x', webPublicUrl: 'https://k.x', delaySec: 300, approvalDelaySec: 60, maxAttempts: 5, inviteTtlDays: 7, ...over,
});
const svc = (c: object) => new EmailAvailability({ get: () => c } as never);

describe('EmailAvailability (S4b D520)', () => {
  it('is configured only with an SMTP url', () => {
    expect(svc(cfg()).configured).toBe(true);
    expect(svc(cfg({ smtpUrl: null })).configured).toBe(false);
  });

  it('joins web paths without a double slash', () => {
    expect(svc(cfg()).webUrl('/invite/abc')).toBe('https://k.x/invite/abc');
    expect(svc(cfg()).webUrl('settings')).toBe('https://k.x/settings');
  });

  it('throws building a link when not configured', () => {
    expect(() => svc(cfg({ smtpUrl: null, webPublicUrl: null })).webUrl('/x')).toThrow();
  });
});
