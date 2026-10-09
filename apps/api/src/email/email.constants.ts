/**
 * Fleet S4b US-002: the email constants consumed by the dispatcher and content builder.
 * `KODA_TENANT_ID` is re-exported here so callers that live outside `email/` do not reach into
 * the notification module for it.
 */
export { KODA_TENANT_ID } from './koda-tenant';

/** D518: default delay between a notification and its email, in seconds (`EMAIL_DELAY_SEC`). */
export const EMAIL_DELAY_SEC = 300;
/** D518: the shorter delay an approval request uses (`EMAIL_APPROVAL_DELAY_SEC`). */
export const EMAIL_APPROVAL_DELAY_SEC = 60;
/** The one notification kind that takes the approval delay (D518). */
export const APPROVAL_REQUESTED_KIND = 'approval_requested';
