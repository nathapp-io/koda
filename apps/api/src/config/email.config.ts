import { registerAs } from '@nestjs/config';

export const EMAIL_CFG = 'email';

export interface IEmailConfig {
  smtpUrl: string | null;
  from: string | null;
  webPublicUrl: string | null;
  delaySec: number;
  approvalDelaySec: number;
  maxAttempts: number;
  inviteTtlDays: number;
}

function intEnv(name: string, fallback: number, min: number, max: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  if (!/^\d+$/.test(raw)) throw new Error(`${name} must be an integer`);
  const value = Number(raw);
  if (value < min || value > max) throw new Error(`${name} must be between ${min} and ${max}`);
  return value;
}

function webUrlEnv(): string | null {
  const raw = process.env['WEB_PUBLIC_URL']?.trim();
  if (!raw) return null;
  if (!/^https?:\/\/[^/\s]+/i.test(raw)) throw new Error('WEB_PUBLIC_URL must be an absolute http(s) URL');
  return raw.endsWith('/') ? raw.slice(0, -1) : raw;
}

/**
 * Fleet S4b §1: SMTP_URL unset means email is off (D520). With SMTP_URL, EMAIL_FROM and WEB_PUBLIC_URL are
 * required. Error messages name the variable, never its value (SMTP_URL carries credentials).
 */
export const emailConfig = registerAs(EMAIL_CFG, (): IEmailConfig => {
  const smtpUrl = process.env['SMTP_URL']?.trim() || null;
  const from = process.env['EMAIL_FROM']?.trim() || null;
  const webPublicUrl = webUrlEnv();
  if (smtpUrl && !from) throw new Error('EMAIL_FROM is required when SMTP_URL is set');
  if (smtpUrl && !webPublicUrl) throw new Error('WEB_PUBLIC_URL is required when SMTP_URL is set');
  return {
    smtpUrl,
    from,
    webPublicUrl,
    delaySec: intEnv('EMAIL_DELAY_SEC', 300, 0, 86_400),
    approvalDelaySec: intEnv('EMAIL_APPROVAL_DELAY_SEC', 60, 0, 86_400),
    maxAttempts: intEnv('EMAIL_MAX_ATTEMPTS', 5, 1, 20),
    inviteTtlDays: intEnv('INVITE_TTL_DAYS', 7, 1, 30),
  };
});
