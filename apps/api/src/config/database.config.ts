import { registerAs } from '@nestjs/config';

export const databaseConfig = registerAs('database', () => ({
  url: process.env['DATABASE_URL'],
  provider: process.env['DATABASE_PROVIDER'] ?? 'sqlite',
}));
