/**
 * VCS CLI Messages
 *
 * CLI output strings for VCS commands.
 * These are English-only as per CLI design standards for developer tools.
 * See CLAUDE.md for details on CLI localization philosophy.
 */

export const VCS_MESSAGES = {
  NO_CONNECTION: 'No VCS connection configured',
  CONNECTION_OK: 'Connection OK',
  DISCONNECTED: (projectSlug: string) => `VCS connection disconnected for project ${projectSlug}`,
  MISSING_REQUIRED_OPTIONS: 'Missing required options: --provider, --owner, --repo, --token',
  MISSING_AUTH: 'API key or URL not configured. Run: koda login --api-key <key>',
  MISSING_PROJECT: 'Project slug not specified. Use --project flag or set via config',
  CONNECTED: (projectSlug: string) => `\nVCS connection established for project ${projectSlug}:`,
  STATUS_HEADER: (projectSlug: string) => `\nVCS Connection status for project ${projectSlug}:`,
  INVALID_ISSUE_NUMBER: 'Issue number must be a valid integer',
  SETTINGS_UPDATED: (projectSlug: string) => `VCS settings updated for project ${projectSlug}`,
  CONNECTION_TEST_FAILED: 'Connection test failed',
  ISSUE_IMPORTED: (ticketRef: string) => `Issue imported: ${ticketRef}`,
} as const;
