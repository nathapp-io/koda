export type {
  EnrollRequest,
  EnrollResponse,
  NaxProtocol,
  ProfileNeeds,
  RunnerArch,
  RunnerCapabilities,
  RunnerExecutor,
  RunnerIdentity,
  RunnerOs,
} from '@nathapp/fleet-protocol';

/**
 * Protocol versions this API accepts. Kept local (not imported from the package at
 * runtime) because the production image does not ship workspace packages; the spec
 * pins it to FLEET_PROTOCOL_VERSION.
 */
export const SUPPORTED_FLEET_PROTOCOL_VERSIONS: readonly number[] = Object.freeze([1]);

export function isSupportedProtocolVersion(value: unknown): value is number {
  return typeof value === 'number' && SUPPORTED_FLEET_PROTOCOL_VERSIONS.includes(value);
}
