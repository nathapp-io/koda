/**
 * US-001 AC5–AC10: `WEBHOOK_ALLOWED_HOSTS` — entry parsing, boot validation and the
 * `webhookConfig` factory.
 *
 * `WEBHOOK_ALLOWED_HOSTS` is a comma-separated list: entries are trimmed, empty entries
 * dropped, an entry containing `/` is a CIDR, anything else is a hostname (lower-cased,
 * one trailing dot stripped). A bad entry must refuse boot, so `validate()` has to report
 * it as a `WEBHOOK_ALLOWED_HOSTS` field error.
 */
import { ValidationAppException } from '@nathapp/nestjs-common';
import {
  DEFAULT_WEBHOOK_DELIVERY_TIMEOUT_MS,
  parseAllowedHosts,
  webhookConfig,
} from './webhook.config';
import { validate } from './env.validation';

const REQUIRED_ENV = {
  DATABASE_URL: 'postgresql://user:pass@localhost:5432/koda',
  JWT_SECRET: 'access-secret',
  JWT_REFRESH_SECRET: 'refresh-secret',
  API_KEY_SECRET: 'api-key-secret',
};

/** Runs `fn` and returns whatever it threw (undefined when it returned normally). */
function captureError(fn: () => unknown): unknown {
  try {
    fn();
    return undefined;
  } catch (error) {
    return error;
  }
}

/** Field names reported by a validation refusal, or `[]` when nothing was thrown. */
function validationFields(thrown: unknown): string[] {
  if (!(thrown instanceof ValidationAppException)) return [];
  return Object.keys(thrown.args ?? {});
}

describe('US-001: webhook allowlist config', () => {
  describe('parseAllowedHosts', () => {
    it('AC5: trims entries, drops empty entries and splits hostnames from CIDRs', () => {
      const parsed = parseAllowedHosts(' Hooks.Internal. ,10.0.0.0/24,, fd00::/8 ');

      expect(parsed.allowedHostnames).toEqual(['hooks.internal']);
      expect(parsed.allowedCidrs).toEqual(['10.0.0.0/24', 'fd00::/8']);
    });

    it('AC5 boundary: lower-cases a hostname that has no trailing dot', () => {
      const parsed = parseAllowedHosts('HOOKS.INTERNAL');

      expect(parsed.allowedHostnames).toEqual(['hooks.internal']);
      expect(parsed.allowedCidrs).toEqual([]);
    });

    it('AC5 boundary: classifies a CIDR entry by its slash and keeps it verbatim', () => {
      const parsed = parseAllowedHosts('10.0.0.0/24');

      expect(parsed.allowedHostnames).toEqual([]);
      expect(parsed.allowedCidrs).toEqual(['10.0.0.0/24']);
    });

    it('AC6: undefined yields empty allowlists', () => {
      const parsed = parseAllowedHosts(undefined);

      expect(parsed.allowedHostnames).toEqual([]);
      expect(parsed.allowedCidrs).toEqual([]);
    });

    it('AC6: an empty string yields empty allowlists', () => {
      const parsed = parseAllowedHosts('');

      expect(parsed.allowedHostnames).toEqual([]);
      expect(parsed.allowedCidrs).toEqual([]);
    });

    it('AC6 boundary: whitespace-only and comma-only input yields empty allowlists', () => {
      const parsed = parseAllowedHosts('  ,  ,, ');

      expect(parsed.allowedHostnames).toEqual([]);
      expect(parsed.allowedCidrs).toEqual([]);
    });

    it('AC7: an IPv4 CIDR with a prefix above 32 throws naming the entry', () => {
      const thrown = captureError(() => parseAllowedHosts('10.0.0.0/33'));

      expect(thrown).toBeInstanceOf(Error);
      expect((thrown as Error).message).toContain('10.0.0.0/33');
    });

    it('AC7 boundary: an IPv6 CIDR with a prefix above 128 throws naming the entry', () => {
      const thrown = captureError(() => parseAllowedHosts('fd00::/129'));

      expect(thrown).toBeInstanceOf(Error);
      expect((thrown as Error).message).toContain('fd00::/129');
    });

    it('AC7 boundary: a valid entry alongside a bad one still throws naming the bad entry', () => {
      const thrown = captureError(() => parseAllowedHosts('hooks.internal,10.0.0.0/33'));

      expect(thrown).toBeInstanceOf(Error);
      expect((thrown as Error).message).toContain('10.0.0.0/33');
    });

    it('AC8: a hostname with an illegal character throws naming the entry', () => {
      const thrown = captureError(() => parseAllowedHosts('bad_host!'));

      expect(thrown).toBeInstanceOf(Error);
      expect((thrown as Error).message).toContain('bad_host!');
    });

    it('AC8 boundary: a hostname label starting with a hyphen throws naming the entry', () => {
      const thrown = captureError(() => parseAllowedHosts('-bad.example'));

      expect(thrown).toBeInstanceOf(Error);
      expect((thrown as Error).message).toContain('-bad.example');
    });

    it('AC8 boundary: a hostname with two trailing dots has only one stripped, so it throws', () => {
      const thrown = captureError(() => parseAllowedHosts('hooks.internal..'));

      expect(thrown).toBeInstanceOf(Error);
      expect((thrown as Error).message).toContain('hooks.internal..');
    });
  });

  describe('boot validation of WEBHOOK_ALLOWED_HOSTS', () => {
    it('AC9: an invalid CIDR refuses boot with a WEBHOOK_ALLOWED_HOSTS field error', () => {
      const thrown = captureError(() =>
        validate({ ...REQUIRED_ENV, WEBHOOK_ALLOWED_HOSTS: '10.0.0.0/33' }),
      );

      expect(thrown).toBeInstanceOf(ValidationAppException);
      expect(validationFields(thrown)).toContain('WEBHOOK_ALLOWED_HOSTS');
    });

    it('AC9 boundary: an invalid hostname refuses boot with a WEBHOOK_ALLOWED_HOSTS field error', () => {
      const thrown = captureError(() =>
        validate({ ...REQUIRED_ENV, WEBHOOK_ALLOWED_HOSTS: 'bad_host!' }),
      );

      expect(thrown).toBeInstanceOf(ValidationAppException);
      expect(validationFields(thrown)).toContain('WEBHOOK_ALLOWED_HOSTS');
    });

    it('AC9 boundary: a valid hostname and CIDR list boots', () => {
      expect(() =>
        validate({ ...REQUIRED_ENV, WEBHOOK_ALLOWED_HOSTS: 'hooks.internal,10.0.0.0/24' }),
      ).not.toThrow();
    });

    it('AC9 boundary: an empty WEBHOOK_ALLOWED_HOSTS boots', () => {
      expect(() => validate({ ...REQUIRED_ENV, WEBHOOK_ALLOWED_HOSTS: '' })).not.toThrow();
    });
  });

  describe('webhookConfig', () => {
    const savedAllowedHosts = process.env['WEBHOOK_ALLOWED_HOSTS'];

    afterEach(() => {
      if (savedAllowedHosts === undefined) delete process.env['WEBHOOK_ALLOWED_HOSTS'];
      else process.env['WEBHOOK_ALLOWED_HOSTS'] = savedAllowedHosts;
    });

    it('AC10: with WEBHOOK_ALLOWED_HOSTS unset it yields empty allowlists and a 5000 ms timeout', () => {
      delete process.env['WEBHOOK_ALLOWED_HOSTS'];

      expect(webhookConfig()).toEqual({
        allowedHostnames: [],
        allowedCidrs: [],
        deliveryTimeoutMs: 5000,
      });
    });

    it('AC10: deliveryTimeoutMs comes from the exported DEFAULT_WEBHOOK_DELIVERY_TIMEOUT_MS', () => {
      delete process.env['WEBHOOK_ALLOWED_HOSTS'];

      expect(webhookConfig().deliveryTimeoutMs).toBe(DEFAULT_WEBHOOK_DELIVERY_TIMEOUT_MS);
    });

    it('AC10 boundary: an invalid entry makes the factory throw instead of serving a bad allowlist', () => {
      process.env['WEBHOOK_ALLOWED_HOSTS'] = '10.0.0.0/33';

      const thrown = captureError(() => webhookConfig());

      expect(thrown).toBeInstanceOf(Error);
      expect((thrown as Error).message).toContain('10.0.0.0/33');
    });

    it('AC10 boundary: WEBHOOK_ALLOWED_HOSTS is read from the environment', () => {
      process.env['WEBHOOK_ALLOWED_HOSTS'] = ' Hooks.Internal. ,10.0.0.0/24 ';

      const cfg = webhookConfig();

      expect(cfg.allowedHostnames).toEqual(['hooks.internal']);
      expect(cfg.allowedCidrs).toEqual(['10.0.0.0/24']);
      expect(cfg.deliveryTimeoutMs).toBe(DEFAULT_WEBHOOK_DELIVERY_TIMEOUT_MS);
    });
  });
});
