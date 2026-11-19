import { ValidationAppException } from '@nathapp/nestjs-common';
import { validate } from './env.validation';
import { webhookSignatureConfig } from './webhook-signature.config';

const withEnv = <T>(values: Record<string, string | undefined>, run: () => T): T => {
  const keys = ['WEBHOOK_SIGNATURE_V1_ENABLED', 'CI_WEBHOOK_REQUIRE_V2'] as const;
  const previous = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
  for (const key of keys) {
    const value = values[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  try {
    return run();
  } finally {
    for (const key of keys) {
      const value = previous[key];
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
};

describe('webhookSignatureConfig', () => {
  it('AC-1: defaults v1Enabled to true', () => {
    expect(withEnv({}, () => webhookSignatureConfig().v1Enabled)).toBe(true);
  });

  it('AC-2: defaults ciRequireV2 to false', () => {
    expect(withEnv({}, () => webhookSignatureConfig().ciRequireV2)).toBe(false);
  });

  it('AC-3: disables v1 for false', () => {
    expect(withEnv({ WEBHOOK_SIGNATURE_V1_ENABLED: 'false' }, () => webhookSignatureConfig().v1Enabled)).toBe(false);
  });

  it('AC-4: disables v1 for uppercase FALSE', () => {
    expect(withEnv({ WEBHOOK_SIGNATURE_V1_ENABLED: 'FALSE' }, () => webhookSignatureConfig().v1Enabled)).toBe(false);
  });

  it('AC-5: requires v2 for true', () => {
    expect(withEnv({ CI_WEBHOOK_REQUIRE_V2: 'true' }, () => webhookSignatureConfig().ciRequireV2)).toBe(true);
  });

  it('AC-6: requires v2 for uppercase TRUE', () => {
    expect(withEnv({ CI_WEBHOOK_REQUIRE_V2: 'TRUE' }, () => webhookSignatureConfig().ciRequireV2)).toBe(true);
  });

  it('AC-7: rejects invalid CI_WEBHOOK_REQUIRE_V2 with a named ValidationAppException', () => {
    let thrown: unknown;
    try {
      validate({
        DATABASE_URL: 'postgresql://u:p@localhost:5432/db',
        JWT_SECRET: 'j'.repeat(32),
        JWT_REFRESH_SECRET: 'r'.repeat(32),
        API_KEY_SECRET: 'k'.repeat(32),
        CI_WEBHOOK_REQUIRE_V2: 'yes',
      });
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(ValidationAppException);
    expect(thrown).toBeInstanceOf(Error);
    expect((thrown as Error).message).toContain('CI_WEBHOOK_REQUIRE_V2');
  });
});
