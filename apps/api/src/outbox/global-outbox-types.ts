import { FLEET_BUDGET_INCIDENT, FLEET_HEALTH_ALERT } from '../notifications/fleet/fleet-notification-events';

/**
 * Fleet S4a D512: outbox types that may have no project (a global budget policy, a fleet health alert).
 * Every other type still requires metadata.projectId.
 */
export const GLOBAL_OUTBOX_TYPES: ReadonlySet<string> = new Set([FLEET_BUDGET_INCIDENT, FLEET_HEALTH_ALERT]);
