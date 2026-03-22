import { registerAs } from '@nestjs/config';

export const appConfig = registerAs('app', () => ({
  port: parseInt(process.env['API_PORT'] ?? '3100', 10),
  nodeEnv: process.env['NODE_ENV'] ?? 'development',
  globalPrefix: process.env['GLOBAL_PREFIX'] ?? 'api',
}));
