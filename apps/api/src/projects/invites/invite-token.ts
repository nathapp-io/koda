/**
 * Fleet S4b US-004 test-writer stub (RED state).
 *
 * The implementer owns the real implementation: 32 random bytes rendered as a
 * base64url string, stored only as its lowercase sha256 hex digest.
 */

export function generateInviteToken(): { raw: string; hash: string } {
  return { raw: 'stub-raw', hash: 'stub-hash' };
}

export function hashInviteToken(_raw: string): string {
  return 'stub-hash';
}
