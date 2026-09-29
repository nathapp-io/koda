/**
 * Koda fleet protocol (spec docs/superpowers/specs/2026-09-29-fleet-s1-dispatch-design.md).
 * Shared by apps/api (type-only) and apps/runner. Bump FLEET_PROTOCOL_VERSION on any
 * incompatible wire change.
 */
export const FLEET_PROTOCOL_VERSION = 1 as const;

export type RunnerOs = 'darwin' | 'linux';
export type RunnerArch = 'arm64' | 'x64';
export type NaxProtocol = 'acp' | 'native';
export type RunnerExecutor = 'host';

export interface ProfileNeeds {
  protocol: NaxProtocol;
  providers: string[];
  sandbox: boolean;
}

/**
 * Validated by the server (#161): `nax.protocols` non-empty and unique; at most 64 profiles
 * named /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/, each with at most 16 providers; at most 64
 * credentials; `expires` must parse as a date. Whole report at most 64 KiB.
 */
export interface RunnerCapabilities {
  nax: { version: string; protocols: NaxProtocol[] };
  sandbox: { available: boolean; probedAt: string; error?: string };
  profiles: Record<string, ProfileNeeds>;
  credentials: Array<{ providerId: string; kind: string; expires?: string }>;
  tools: { git: boolean; gh: boolean; glab: boolean };
  executors: RunnerExecutor[];
}

export interface EnrollRequest {
  enrollmentToken: string;
  name: string;
  os: RunnerOs;
  arch: RunnerArch;
  daemonVersion: string;
  protocolVersion: number;
  bootId: string;
  labels: string[];
  capabilities: RunnerCapabilities;
}

export interface EnrollResponse {
  runnerId: string;
  apiKey: string;
}

export interface RunnerIdentity {
  id: string;
  name: string;
  labels: string[];
  capacity: number;
  enabled: boolean;
}
