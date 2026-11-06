import { restoreEnvAfterEach } from '../common/test-helpers/restore-env';
import { validate } from './env.validation';
import { PROVIDER_CREDENTIALS_CFG, providerCredentialsConfig } from './provider-credentials.config';

const KEY = 'PROVIDER_CREDENTIAL_ENCRYPTION_KEY';
const MASTER_KEY = '0123456789abcdef'.repeat(4);

/** The minimum env `env.validation` needs before it looks at the vault key. */
const REQUIRED = {
  DATABASE_URL: 'postgresql://u:p@localhost:5432/db',
  JWT_SECRET: 's',
  JWT_REFRESH_SECRET: 'r',
  API_KEY_SECRET: 'k',
};

describe('provider credential env + config', () => {
  restoreEnvAfterEach();

  describe('PROVIDER_CREDENTIAL_ENCRYPTION_KEY validation', () => {
    it('AC-7: accepts a missing PROVIDER_CREDENTIAL_ENCRYPTION_KEY', () => {
      delete process.env[KEY];
      const { PROVIDER_CREDENTIAL_ENCRYPTION_KEY: _omit, ...withoutKey } = REQUIRED;

      expect(() => validate({ ...withoutKey })).not.toThrow();
      expect(() => validate({ ...withoutKey, PROVIDER_CREDENTIAL_ENCRYPTION_KEY: MASTER_KEY })).not.toThrow();
    });

    it('AC-8: refuses a PROVIDER_CREDENTIAL_ENCRYPTION_KEY that is not 64 hex characters', () => {
      const { PROVIDER_CREDENTIAL_ENCRYPTION_KEY: _omit, ...withoutKey } = REQUIRED;

      expect(() => validate({ ...withoutKey, [KEY]: MASTER_KEY.slice(0, 48) })).toThrow(KEY);
      expect(() => validate({ ...withoutKey, [KEY]: `${MASTER_KEY}00` })).toThrow(KEY);
      expect(() => validate({ ...withoutKey, [KEY]: 'z'.repeat(64) })).toThrow(KEY);
    });

    it('AC-15: still rejects an invalid VCS_ENCRYPTION_KEY when PROVIDER_CREDENTIAL_ENCRYPTION_KEY is absent', () => {
      const { PROVIDER_CREDENTIAL_ENCRYPTION_KEY: _omit, ...withoutKey } = REQUIRED;

      expect(() => validate({ ...withoutKey, VCS_ENCRYPTION_KEY: 'not-a-hex-key' })).toThrow('VCS_ENCRYPTION_KEY');
      expect(() => validate({ ...withoutKey, VCS_ENCRYPTION_KEY: MASTER_KEY })).not.toThrow();
    });
  });

  describe('providerCredentials namespace', () => {
    it('AC-9: exposes encryptionKey from PROVIDER_CREDENTIAL_ENCRYPTION_KEY', () => {
      process.env[KEY] = MASTER_KEY;

      expect(providerCredentialsConfig().encryptionKey).toBe(MASTER_KEY);
    });

    it('AC-9: exposes undefined when PROVIDER_CREDENTIAL_ENCRYPTION_KEY is unset', () => {
      delete process.env[KEY];

      expect(providerCredentialsConfig().encryptionKey).toBeUndefined();
    });

    it('registers under the namespace named in the brief', () => {
      expect(PROVIDER_CREDENTIALS_CFG).toBe('providerCredentials');
      expect(providerCredentialsConfig()).toBeDefined();
    });
  });
});
