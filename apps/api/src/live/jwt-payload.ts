/**
 * Reads claims from a JWT the auth guard has ALREADY verified. This does not
 * verify signatures and must never be used to authenticate.
 */
export function decodeJwtPayload(token: string | null): Record<string, unknown> | null {
  if (!token) return null;
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  try {
    const value: unknown = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
    return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

export function tokenExpiryMs(payload: Record<string, unknown>): number | null {
  const exp = payload['exp'];
  return typeof exp === 'number' && Number.isFinite(exp) ? exp * 1000 : null;
}
