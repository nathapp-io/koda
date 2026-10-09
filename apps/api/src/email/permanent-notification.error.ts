/**
 * Fleet S4b US-002: re-exported so the dispatcher and its callers share one error type without
 * importing the notify package directly.
 */
export { PermanentNotificationError } from '@nathapp/nestjs-notify';
