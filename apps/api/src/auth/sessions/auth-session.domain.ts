/**
 * auth-sessions US-001 — the session store's domain contract and its module-private DI token.
 *
 * The domain types are plain shapes: no Prisma model or client type leaves the repository, and the
 * service's callers (login and refresh) see only these. The token is provided and consumed inside
 * `AuthSessionsModule`; it is never exported.
 */

/** The repository's DI token. Module-private: `AuthSessionsModule` exports only the service. */
export const AUTH_SESSION_REPOSITORY = Symbol('AUTH_SESSION_REPOSITORY');

/**
 * Why a session ended. This feature writes `logout` and `reuse`; `password-change` and
 * `password-reset` belong to the follow-up `auth-passwords` feature.
 */
export type SessionRevokeReason = 'logout' | 'reuse' | 'password-change' | 'password-reset';

/** One sign-in as the service sees it. `id` is the refresh JWT's `sid`. */
export interface AuthSessionDomain {
  id: string;
  userId: string;
  createdAt: Date;
  expiresAt: Date;
  revokedAt: Date | null;
  revokedReason: SessionRevokeReason | null;
}

/** One issued refresh JWT as the service sees it. `id` is the token's `jti`. */
export interface RefreshTokenDomain {
  id: string;
  sessionId: string;
  createdAt: Date;
  usedAt: Date | null;
}

/** The session `start` writes; `createdAt` stays the column default, which is the login's own time. */
export interface NewAuthSession {
  id: string;
  userId: string;
  expiresAt: Date;
}

/**
 * A refresh token to insert. `createdAt` is passed by a rotation so the row carries the rotation's
 * explicit `now`; a session start leaves it to the column default.
 */
export interface NewRefreshToken {
  id: string;
  sessionId: string;
  createdAt?: Date;
}
