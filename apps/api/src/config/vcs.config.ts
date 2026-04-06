import { registerAs } from '@nestjs/config';

export const vcsConfig = registerAs('vcs', () => ({
  encryptionKey: process.env['VCS_ENCRYPTION_KEY'],
  defaultPollingIntervalMs: parseInt(
    process.env['VCS_DEFAULT_POLLING_INTERVAL_MS'] ?? '3600000', // 1 hour default
    10,
  ),
  githubApiUrl: process.env['VCS_GITHUB_API_URL'] ?? 'https://api.github.com',
}));
