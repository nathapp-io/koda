import { authConfig } from '../../../src/config/auth.config';
import { validate } from '../../../src/config/env.validation';

const required = {
  DATABASE_URL: 'postgresql://user:pass@localhost:5432/koda_test',
  JWT_SECRET: 'access-secret', JWT_REFRESH_SECRET: 'refresh-secret', API_KEY_SECRET: 'api-key-secret',
};

describe('retired agent scoping flag', () => {
  afterEach(() => vi.unstubAllEnvs());

  it('AC-1: env validation ignores a bogus scoping value', () => {
    expect(() => validate({ ...required, AGENT_PROJECT_SCOPING: 'bogus' })).not.toThrow();
  });

  it('AC-2: auth factory ignores a bogus scoping value', () => {
    for (const [key, value] of Object.entries(required)) vi.stubEnv(key, value);
    vi.stubEnv('AGENT_PROJECT_SCOPING', 'bogus');
    expect(() => authConfig()).not.toThrow();
    expect(authConfig()).not.toHaveProperty('agentProjectScoping');
  });
});
