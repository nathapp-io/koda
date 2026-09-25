import { validate } from './env.validation';

const REQUIRED = {
  DATABASE_URL: 'postgresql://u:p@localhost:5432/db',
  JWT_SECRET: 's',
  JWT_REFRESH_SECRET: 'r',
  API_KEY_SECRET: 'k',
};

describe('env validation', () => {
  it('does not inject a DATABASE_PROVIDER default', () => {
    const out = validate({ ...REQUIRED });
    expect(out).not.toHaveProperty('DATABASE_PROVIDER');
  });

  it('still requires DATABASE_URL', () => {
    const { DATABASE_URL: _omit, ...withoutUrl } = REQUIRED;
    expect(() => validate(withoutUrl)).toThrow();
  });
});
