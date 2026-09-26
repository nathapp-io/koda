/// <reference types="jest" />

import { IAuthConfig, authConfig } from './auth.config';

describe('authConfig defaults', () => {
  it('uses hardened defaults when expiry env vars are unset', () => {
    const prevJwtExpiresIn = process.env['JWT_EXPIRES_IN'];
    const prevJwtRefreshExpiresIn = process.env['JWT_REFRESH_EXPIRES_IN'];

    delete process.env['JWT_EXPIRES_IN'];
    delete process.env['JWT_REFRESH_EXPIRES_IN'];

    try {
      const config = authConfig();
      expect(config.jwtExpiresIn).toBe('15m');
      expect(config.jwtRefreshExpiresIn).toBe('7d');
    } finally {
      if (prevJwtExpiresIn !== undefined) {
        process.env['JWT_EXPIRES_IN'] = prevJwtExpiresIn;
      } else {
        delete process.env['JWT_EXPIRES_IN'];
      }

      if (prevJwtRefreshExpiresIn !== undefined) {
        process.env['JWT_REFRESH_EXPIRES_IN'] = prevJwtRefreshExpiresIn;
      } else {
        delete process.env['JWT_REFRESH_EXPIRES_IN'];
      }
    }
  });

  it('uses explicit env values when provided', () => {
    const prevJwtExpiresIn = process.env['JWT_EXPIRES_IN'];
    const prevJwtRefreshExpiresIn = process.env['JWT_REFRESH_EXPIRES_IN'];

    process.env['JWT_EXPIRES_IN'] = '1h';
    process.env['JWT_REFRESH_EXPIRES_IN'] = '14d';

    try {
      const config = authConfig();
      expect(config.jwtExpiresIn).toBe('1h');
      expect(config.jwtRefreshExpiresIn).toBe('14d');
    } finally {
      if (prevJwtExpiresIn !== undefined) {
        process.env['JWT_EXPIRES_IN'] = prevJwtExpiresIn;
      } else {
        delete process.env['JWT_EXPIRES_IN'];
      }

      if (prevJwtRefreshExpiresIn !== undefined) {
        process.env['JWT_REFRESH_EXPIRES_IN'] = prevJwtRefreshExpiresIn;
      } else {
        delete process.env['JWT_REFRESH_EXPIRES_IN'];
      }
    }
  });

  it('returns typed IAuthConfig', () => {
    const prevJwtSecret = process.env['JWT_SECRET'];
    const prevJwtRefreshSecret = process.env['JWT_REFRESH_SECRET'];
    const prevApiKeySecret = process.env['API_KEY_SECRET'];

    process.env['JWT_SECRET'] = 'test-secret';
    process.env['JWT_REFRESH_SECRET'] = 'test-refresh-secret';
    process.env['API_KEY_SECRET'] = 'test-api-key-secret';
    try {
      const cfg: IAuthConfig = authConfig();
      expect(cfg.jwtSecret).toBe('test-secret');
      expect(cfg.apiKeySecret).toBe('test-api-key-secret');
    } finally {
      if (prevJwtSecret !== undefined) {
        process.env['JWT_SECRET'] = prevJwtSecret;
      } else {
        delete process.env['JWT_SECRET'];
      }

      if (prevJwtRefreshSecret !== undefined) {
        process.env['JWT_REFRESH_SECRET'] = prevJwtRefreshSecret;
      } else {
        delete process.env['JWT_REFRESH_SECRET'];
      }

      if (prevApiKeySecret !== undefined) {
        process.env['API_KEY_SECRET'] = prevApiKeySecret;
      } else {
        delete process.env['API_KEY_SECRET'];
      }
    }
  });
});

describe('authConfig registrationEnabled', () => {
  const prev = process.env['REGISTRATION_ENABLED'];

  afterEach(() => {
    if (prev === undefined) delete process.env['REGISTRATION_ENABLED'];
    else process.env['REGISTRATION_ENABLED'] = prev;
  });

  it('defaults to false when unset', () => {
    delete process.env['REGISTRATION_ENABLED'];
    expect(authConfig().registrationEnabled).toBe(false);
  });

  it('is true only for the string "true"', () => {
    process.env['REGISTRATION_ENABLED'] = 'true';
    expect(authConfig().registrationEnabled).toBe(true);
    process.env['REGISTRATION_ENABLED'] = 'false';
    expect(authConfig().registrationEnabled).toBe(false);
  });

  it('rejects any other value at boot', () => {
    process.env['REGISTRATION_ENABLED'] = 'yes';
    expect(() => authConfig()).toThrow();
  });
});
