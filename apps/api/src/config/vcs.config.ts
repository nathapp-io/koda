import { registerAs } from '@nestjs/config';

export const vcsConfig = registerAs('vcs', () => ({
  encryptionKey: process.env['VCS_ENCRYPTION_KEY'],
  defaultPollingIntervalMs: parseInt(
    process.env['VCS_DEFAULT_POLLING_INTERVAL_MS'] ?? '600000',
    10,
  ),
  githubApiUrl: process.env['GITHUB_API_URL'] ?? 'https://api.github.com',
}));
