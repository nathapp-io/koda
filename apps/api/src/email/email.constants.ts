/**
 * Fleet S4b US-002: the email constants consumed by the dispatcher and content builder.
 * `KODA_TENANT_ID` is re-exported here so callers that live outside `email/` do not reach into
 * the notification module for it.
 */
export { KODA_TENANT_ID } from './koda-tenant';
