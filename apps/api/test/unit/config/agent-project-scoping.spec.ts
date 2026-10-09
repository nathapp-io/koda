import { authConfig } from '../../../src/config/auth.config';
import { validate } from '../../../src/config/env.validation';

const REQUIRED_ENV = {
  DATABASE_URL: 'postgresql://user:pass@localhost:5432/koda',
  JWT_SECRET: 'access-secret',
  JWT_REFRESH_SECRET: 'refresh-secret',
  API_KEY_SECRET: 'api-key-secret',
};

describe('US-001 agent project scoping configuration', () => {
  const envSnapshot: Record<string, string | undefined> = { ...process.env };

  afterEach(() => {
    for (const key of Object.keys(process.env)) {
      if (!(key in envSnapshot)) delete process.env[key];
    }
    for (const [key, value] of Object.entries(envSnapshot)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  it('US-001 AC1: defaults authConfig to agent project scoping enabled', () => {
    Object.assign(process.env, REQUIRED_ENV);
    delete process.env.AGENT_PROJECT_SCOPING;

    expect(authConfig()).toHaveProperty('agentProjectScoping', true);
  });

  it('US-001 AC2: rejects an unsupported scoping value naming AGENT_PROJECT_SCOPING', () => {
    expect(() => validate({ ...REQUIRED_ENV, AGENT_PROJECT_SCOPING: 'maybe' })).toThrow(
      /AGENT_PROJECT_SCOPING/,
    );

    // The AC names the config factory the app boots with, so pin that path too:
    // it validates through AuthConfigSchema rather than the Joi env schema.
    Object.assign(process.env, REQUIRED_ENV);
    process.env.AGENT_PROJECT_SCOPING = 'maybe';

    expect(() => authConfig()).toThrow(/AGENT_PROJECT_SCOPING/);
  });
});
