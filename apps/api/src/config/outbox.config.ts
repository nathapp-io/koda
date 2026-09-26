import { validateUtil } from '@nathapp/nestjs-common';
import { registerAs } from '@nestjs/config';
import { IsOptional, Matches } from 'class-validator';

export const OUTBOX_CFG = 'outbox';

export interface OutboxRelayConfig {
  enabled: boolean;
  pollIntervalMs: number;
  batchSize: number;
  leaseMs: number;
  maxAttempts: number;
  backoffBaseMs: number;
  backoffCapMs: number;
}

export interface OutboxRetentionConfig {
  /** Days a terminal (published/dead) row survives before the nightly purge. null disables the purge. */
  days: number | null;
}

export interface IOutboxConfig {
  relay: OutboxRelayConfig;
  retention: OutboxRetentionConfig;
}

export class OutboxConfigSchema {
  // Case-insensitive to match the Joi `OUTBOX_RELAY_ENABLED` rule in env.validation.ts.
  @IsOptional()
  @Matches(/^(true|false)$/i)
  OUTBOX_RELAY_ENABLED?: string;

  // Digits-only to match the Joi `OUTBOX_RETENTION_DAYS` rule in env.validation.ts.
  @IsOptional()
  @Matches(/^\d+$/)
  OUTBOX_RETENTION_DAYS?: string;
}

/**
 * Relay settings for @nathapp/nestjs-outbox (Track 1 slice 2).
 * The relay polls unless running under Jest (NODE_ENV=test), where tests
 * drive it explicitly via OutboxRelay.dispatchPendingBatch().
 * OUTBOX_RELAY_ENABLED overrides the default in either direction.
 *
 * Retention (issue #135): a nightly purge deletes terminal (published/dead)
 * rows older than OUTBOX_RETENTION_DAYS. Default 30 outside tests, disabled
 * under NODE_ENV=test (same default rule as the relay); 0 is the kill switch.
 */
export const outboxConfig = registerAs(OUTBOX_CFG, (): IOutboxConfig => {
  validateUtil(process.env, OutboxConfigSchema);
  const override = process.env['OUTBOX_RELAY_ENABLED'];
  const enabled = override !== undefined ? override.toLowerCase() === 'true' : process.env['NODE_ENV'] !== 'test';
  const retentionOverride = process.env['OUTBOX_RETENTION_DAYS'];
  const parsedRetention = retentionOverride !== undefined ? parseInt(retentionOverride, 10) : NaN;
  const days = retentionOverride !== undefined
    ? (parsedRetention > 0 ? parsedRetention : null)
    : process.env['NODE_ENV'] !== 'test'
      ? 30
      : null;
  return {
    relay: {
      enabled,
      pollIntervalMs: 1000,
      batchSize: 20,
      leaseMs: 30000,
      maxAttempts: 8,
      backoffBaseMs: 2000,
      backoffCapMs: 300000,
    },
    retention: { days },
  };
});
