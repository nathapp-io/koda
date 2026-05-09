import { registerAs } from '@nestjs/config';

export const authConfig = registerAs('auth', () => ({
  jwtSecret: process.env['JWT_SECRET'],
  jwtExpiresIn: process.env['JWT_EXPIRES_IN'] ?? '15m',
  jwtRefreshSecret: process.env['JWT_REFRESH_SECRET'],
  jwtRefreshExpiresIn: process.env['JWT_REFRESH_EXPIRES_IN'] ?? '7d',
  apiKeySecret: process.env['API_KEY_SECRET'],
}));
