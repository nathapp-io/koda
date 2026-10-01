import { ValidationAppException } from '@nathapp/nestjs-common';
import type { RunnerCapabilities } from './protocol';
import { CapabilityValidationError, parseCapabilitiesCore } from './capabilities-core';

export {
  MAX_CAPABILITIES_BYTES, MAX_CREDENTIALS, MAX_PROFILES, MAX_PROVIDERS_PER_PROFILE, PROFILE_NAME_RE, CapabilityValidationError,
} from './capabilities-core';

/** Validates a runner's self-reported capabilities (untrusted input, spec §2.1) and returns a clean copy. */
export function parseCapabilities(raw: unknown): RunnerCapabilities {
  try {
    return parseCapabilitiesCore(raw);
  } catch (error) {
    if (error instanceof CapabilityValidationError) throw new ValidationAppException({ reason: error.reason }, 'fleet.capabilities');
    throw error;
  }
}
