import { validateUtil } from '@nathapp/nestjs-common';
import { registerAs } from '@nestjs/config';
import { IsOptional, Matches } from 'class-validator';

export const LIVE_CFG = 'live';
export const DEFAULT_LIVE_HEARTBEAT_MS = 25_000;
export const MIN_LIVE_HEARTBEAT_MS = 100;
/**
 * Per-user open streams across project streams and `/me/events` (S4a D509). Every signed-in tab holds the user
 * stream and a project page adds its own, so 10 keeps five project tabs live (was 5 before the S4a bell).
 */
export const MAX_LIVE_STREAMS_PER_USER = 10;

export interface ILiveConfig {
  heartbeatMs: number;
  maxStreamsPerUser: number;
}

export class LiveConfigSchema {
  // Digits-only to match the Joi `LIVE_HEARTBEAT_MS` rule in env.validation.ts.
  @IsOptional()
  @Matches(/^\d+$/)
  LIVE_HEARTBEAT_MS?: string;
}

/**
 * Track 1 Slice 5 SSE settings. The heartbeat both keeps the stream alive and
 * paces access re-validation; tests shorten it to observe revocation quickly.
 */
export const liveConfig = registerAs(LIVE_CFG, (): ILiveConfig => {
  validateUtil(process.env, LiveConfigSchema);
  const raw = process.env['LIVE_HEARTBEAT_MS'];
  const parsed = raw !== undefined ? parseInt(raw, 10) : DEFAULT_LIVE_HEARTBEAT_MS;
  return {
    heartbeatMs: Math.max(MIN_LIVE_HEARTBEAT_MS, parsed),
    maxStreamsPerUser: MAX_LIVE_STREAMS_PER_USER,
  };
});
