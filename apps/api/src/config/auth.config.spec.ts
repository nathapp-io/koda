/// <reference types="jest" />

import { authConfig } from './auth.config';

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
});
