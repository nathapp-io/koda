/**
 * US-004: environment validation for independent JWT secrets.
 *
 * Acceptance Criteria:
 * 10. validate throws a validation error naming JWT_REFRESH_SECRET when
 *     JWT_REFRESH_SECRET equals JWT_SECRET.
 * 11. validate passes when JWT_SECRET and JWT_REFRESH_SECRET are distinct.
 * 16. When JWT_REFRESH_SECRET equals JWT_SECRET at boot, env validation throws
 *     and the app does not start.
 *
 * `validate` is the function `AppModule` hands to `ConfigModule.forRoot({ validate })`,
 * so a rejection there aborts module creation — the boot test below drives that
 * exact wiring.
 */
import { ConfigModule } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import { AppException, ValidationAppException } from '@nathapp/nestjs-common';
import { validate } from '../../../src/config/env.validation';

const REQUIRED_ENV = {
  DATABASE_URL: 'postgresql://user:pass@localhost:5432/koda',
  JWT_SECRET: 'access-secret',
  JWT_REFRESH_SECRET: 'refresh-secret',
  API_KEY_SECRET: 'api-key-secret',
};

/** Human-readable detail of an error, including an AppException's response payload. */
function errorText(error: unknown): string {
  if (error instanceof AppException) return JSON.stringify(error.getResponse());
  if (error instanceof Error) return `${error.name}: ${error.message}`;
  return String(error);
}

/**
 * Boot the same ConfigModule wiring AppModule uses and return whatever error
 * stopped it (undefined when the module came up cleanly).
 */
async function bootConfigModuleAndCaptureError(): Promise<unknown> {
  // ConfigModule.forRoot writes the validated config back into process.env, so
  // the whole environment is snapshotted and restored to keep this file hermetic.
  const envSnapshot: Record<string, string | undefined> = { ...process.env };

  process.env.JWT_SECRET = 'identical-boot-secret';
  process.env.JWT_REFRESH_SECRET = 'identical-boot-secret';

  try {
    const moduleRef = await Test.createTestingModule({
      imports: [
        await ConfigModule.forRoot({
          isGlobal: true,
          ignoreEnvFile: true,
          validate,
        }),
      ],
    }).compile();
    await moduleRef.close();
    return undefined;
  } catch (error) {
    return error;
  } finally {
    for (const key of Object.keys(process.env)) {
      if (!(key in envSnapshot)) delete process.env[key];
    }
    for (const [key, value] of Object.entries(envSnapshot)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

describe('US-004: env validation', () => {
  describe('JWT_REFRESH_SECRET must be independent from JWT_SECRET', () => {
    const identicalSecrets = {
      ...REQUIRED_ENV,
      JWT_SECRET: 'identical-secret',
      JWT_REFRESH_SECRET: 'identical-secret',
    };

    it('AC10: throws a validation error when JWT_REFRESH_SECRET equals JWT_SECRET', () => {
      expect(() => validate(identicalSecrets)).toThrow(ValidationAppException);
    });

    it('AC10: the validation error names JWT_REFRESH_SECRET', () => {
      let thrown: unknown;
      try {
        validate(identicalSecrets);
      } catch (error) {
        thrown = error;
      }

      expect(thrown).toBeDefined();
      expect(errorText(thrown)).toContain('JWT_REFRESH_SECRET');
    });

    it('AC11: passes when JWT_SECRET and JWT_REFRESH_SECRET are distinct', () => {
      const result = validate({
        ...REQUIRED_ENV,
        JWT_SECRET: 'access-secret',
        JWT_REFRESH_SECRET: 'refresh-secret',
      });

      expect(result['JWT_SECRET']).toBe('access-secret');
      expect(result['JWT_REFRESH_SECRET']).toBe('refresh-secret');
    });

    it('AC11: passes when one secret is merely a prefix of the other', () => {
      expect(() =>
        validate({
          ...REQUIRED_ENV,
          JWT_SECRET: 'shared-prefix',
          JWT_REFRESH_SECRET: 'shared-prefix-with-suffix',
        }),
      ).not.toThrow();
    });

    it('AC16: boot with JWT_REFRESH_SECRET equal to JWT_SECRET throws and the module does not start', async () => {
      const error = await bootConfigModuleAndCaptureError();

      expect(error).toBeInstanceOf(ValidationAppException);
      expect(errorText(error)).toContain('JWT_REFRESH_SECRET');
    });
  });
});
