/**
 * The marker a redacted secret is stored as (`gate-secret`, US-002).
 *
 * Every redeem command in this feature maps its secret-bearing fields through `redactSecret`, so the
 * stored input — and therefore the hash a redemption has to match — carries no secret. Two calls whose
 * secret differs are then the same approved call, which is what lets a requester redeem a token
 * approval with a different token value.
 */
export const REDACTED_SECRET = '<redacted>';

/**
 * A string is a secret and answers the marker; anything else (`null`, `undefined`) is not a secret and
 * answers itself. `null` is how a patch clears a token, and `undefined` is how it says nothing about
 * one — neither is secret, and collapsing them to the marker would make a clear unmatchable.
 */
export function redactSecret(value: string): typeof REDACTED_SECRET;
export function redactSecret(value: string | null): typeof REDACTED_SECRET | null;
export function redactSecret(value: string | undefined): typeof REDACTED_SECRET | undefined;
export function redactSecret(value: string | null | undefined): typeof REDACTED_SECRET | null | undefined;
export function redactSecret(value: string | null | undefined): typeof REDACTED_SECRET | null | undefined {
  return typeof value === 'string' ? REDACTED_SECRET : value;
}
