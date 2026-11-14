import { Inject, Injectable } from '@nestjs/common';
import { AbstractPrismaRepository, PrismaClientLike, PrismaModelDelegate, PrismaService } from '@nathapp/nestjs-prisma';
import { ITransactionManager, TRANSACTION_MANAGER } from '@nathapp/nestjs-data';
import { AuthSession as AuthSessionModel, PrismaClient, RefreshToken as RefreshTokenModel } from '../../generated/prisma/client';
import {
  AuthSessionDomain,
  NewAuthSession,
  NewRefreshToken,
  RefreshTokenDomain,
  SessionRevokeReason,
} from './auth-session.domain';

/**
 * auth-sessions US-001 — the only place that touches the session tables.
 *
 * Every mutation is one conditional statement whose affected count is the answer the service decides on.
 * The conditions are the point: a rotation slides the session only while it is live, and marks a token
 * used only while it is unused, so two concurrent rotations — or a rotation racing a logout — cannot both
 * write the same row. The update is the lock: Postgres serialises them on the row, and the second one
 * re-reads the committed row before it decides (READ COMMITTED).
 *
 * `AbstractPrismaRepository` is the base (it owns the transaction-manager handle and the mapping
 * contract); the session-specific queries are escape hatches on `PrismaService`, which inside
 * `txManager.run` is the transaction's own client.
 */
@Injectable()
export class PrismaAuthSessionRepository extends AbstractPrismaRepository<AuthSessionDomain, AuthSessionModel, string> {
  constructor(
    @Inject(TRANSACTION_MANAGER) tx: ITransactionManager,
    private readonly prisma: PrismaService<PrismaClient>,
  ) {
    super(tx);
  }

  private get db() {
    return this.prisma.client;
  }

  protected modelDelegate(client: PrismaClientLike): PrismaModelDelegate<AuthSessionModel, string> {
    return (client as unknown as Record<string, PrismaModelDelegate<AuthSessionModel, string>>)['authSession'];
  }

  protected toDomain(model: AuthSessionModel): AuthSessionDomain {
    return {
      id: model.id,
      userId: model.userId,
      createdAt: model.createdAt,
      expiresAt: model.expiresAt,
      revokedAt: model.revokedAt,
      revokedReason: model.revokedReason as SessionRevokeReason | null,
    };
  }

  protected toPersistenceCreate(domain: AuthSessionDomain) {
    return {
      id: domain.id,
      userId: domain.userId,
      createdAt: domain.createdAt,
      expiresAt: domain.expiresAt,
      revokedAt: domain.revokedAt,
      revokedReason: domain.revokedReason,
    };
  }

  protected toPersistenceUpdate(patch: Partial<AuthSessionDomain>) {
    return { ...patch };
  }

  /** Inserts the session of a sign-in; its one refresh token is inserted right after by `createToken`. */
  async createSession(session: NewAuthSession): Promise<void> {
    await this.db.authSession.create({
      data: { id: session.id, userId: session.userId, expiresAt: session.expiresAt },
    });
  }

  /** Inserts one refresh token row; `createdAt` is left to the column default unless the caller has a `now`. */
  async createToken(token: NewRefreshToken): Promise<void> {
    await this.db.refreshToken.create({
      data: { id: token.id, sessionId: token.sessionId, ...(token.createdAt ? { createdAt: token.createdAt } : {}) },
    });
  }

  /**
   * Slides the expiry of a live session: one conditional update that writes nothing when the session is
   * missing, revoked or expired. Returns whether the row was live and is now slid.
   */
  async slideExpiry(sessionId: string, expiresAt: Date, now: Date): Promise<boolean> {
    const { count } = await this.db.authSession.updateMany({
      where: { id: sessionId, revokedAt: null, expiresAt: { gt: now } },
      data: { expiresAt },
    });
    return count > 0;
  }

  /**
   * Marks the presented token used, if it is unused and belongs to the session. The affected count is the
   * answer: 1 means this rotation is the first to present it.
   */
  async markUsed(sessionId: string, tokenId: string, now: Date): Promise<number> {
    const { count } = await this.db.refreshToken.updateMany({
      where: { id: tokenId, sessionId, usedAt: null },
      data: { usedAt: now },
    });
    return count;
  }

  /** The presented token's row, scoped to the session, or null when the `jti` has none. */
  async findToken(tokenId: string, sessionId: string): Promise<RefreshTokenDomain | null> {
    const model: RefreshTokenModel | null = await this.db.refreshToken.findUnique({ where: { id: tokenId, sessionId } });
    if (model === null) return null;
    return { id: model.id, sessionId: model.sessionId, createdAt: model.createdAt, usedAt: model.usedAt };
  }

  /**
   * Deletes the session's tokens used before `threshold`. Unused tokens are never deleted, so a sibling
   * a concurrent refresh issued stays valid.
   */
  async deleteUsedTokensBefore(sessionId: string, threshold: Date): Promise<number> {
    const { count } = await this.db.refreshToken.deleteMany({
      where: { sessionId, usedAt: { lt: threshold } },
    });
    return count;
  }

  /**
   * Revokes the session unless it is already revoked, and answers the owner's id so the caller can
   * report the reuse. Null only when the session row does not exist.
   */
  async revokeSession(sessionId: string, reason: SessionRevokeReason, now: Date): Promise<string | null> {
    const revoked = await this.db.authSession.updateManyAndReturn({
      where: { id: sessionId, revokedAt: null },
      data: { revokedAt: now, revokedReason: reason },
      select: { userId: true },
    });
    if (revoked.length > 0) return revoked[0].userId;

    // Already revoked by another rotation, or never existed: report the owner of the row that is there.
    const existing = await this.db.authSession.findUnique({ where: { id: sessionId }, select: { userId: true } });
    return existing?.userId ?? null;
  }
}
