import { SetMetadata } from '@nestjs/common';

/** Runner API keys start with this prefix; agent keys are 64 bare hex characters. */
export const RUNNER_KEY_PREFIX = 'kr_';
export const RUNNER_ROUTE_KEY = 'koda:fleetRunnerRoute';

/**
 * Marks a controller or handler as a fleet runner route. CombinedAuthGuard then
 * accepts only runner keys there, and refuses runner keys everywhere else.
 */
export const RunnerRoute = () => SetMetadata(RUNNER_ROUTE_KEY, true);
