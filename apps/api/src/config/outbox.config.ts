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

export interface IOutboxConfig {
  relay: OutboxRelayConfig;
}

export class OutboxConfigSchema {
  // Case-insensitive to match the Joi `OUTBOX_RELAY_ENABLED` rule in env.validation.ts.
  @IsOptional()
  @Matches(/^(true|false)$/i)
  OUTBOX_RELAY_ENABLED?: string;
}

/**
 * Relay settings for @nathapp/nestjs-outbox (Track 1 slice 2).
 * The relay polls unless running under Jest (NODE_ENV=test), where tests
 * drive it explicitly via OutboxRelay.dispatchPendingBatch().
 * OUTBOX_RELAY_ENABLED overrides the default in either direction.
 */
export const outboxConfig = registerAs(OUTBOX_CFG, (): IOutboxConfig => {
  validateUtil(process.env, OutboxConfigSchema);
  const override = process.env['OUTBOX_RELAY_ENABLED'];
  const enabled = override !== undefined ? override.toLowerCase() === 'true' : process.env['NODE_ENV'] !== 'test';
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
  };
});
