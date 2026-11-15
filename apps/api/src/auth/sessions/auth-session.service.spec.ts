/**
 * auth-sessions US-001 — the rotation decision in `AuthSessionService`, without a database.
 *
 * The store's behavior on real Postgres lives in `test/integration/auth/auth-sessions.integration.spec.ts`.
 * These cases pin the branch order and the arguments each branch hands the repository, plus the two
 * `bookkeeping` reasons that keep login and refresh within the audit-coverage rule. The repository is
 * mocked here on purpose: no concurrency is asserted, so no concurrent claim is faked.
 */
import type { ITransactionManager } from '@nathapp/nestjs-data';
import { currentBookkeepingReason, openAuditScope } from '../../action-context/audit-coverage';
import { AuthSessionService, LOST_RESPONSE_WINDOW_MS, REFRESH_REUSE_GRACE_MS } from './auth-session.service';
import type { RefreshTokenDomain } from './auth-session.domain';
import type { PrismaAuthSessionRepository } from './prisma-auth-session.repository';

const t0 = new Date('2026-12-10T09:00:00.000Z');
const at = (ms: number): Date => new Date(t0.getTime() + ms);

interface RepositoryStub {
  createSession: ReturnType<typeof vi.fn>;
  createToken: ReturnType<typeof vi.fn>;
  slideExpiry: ReturnType<typeof vi.fn>;
  markUsed: ReturnType<typeof vi.fn>;
  deleteUsedTokensBefore: ReturnType<typeof vi.fn>;
  findToken: ReturnType<typeof vi.fn>;
  hasTokenUsedAfter: ReturnType<typeof vi.fn>;
  deleteUnusedTokens: ReturnType<typeof vi.fn>;
  revokeSession: ReturnType<typeof vi.fn>;
  revokeOwnedSession: ReturnType<typeof vi.fn>;
  isSessionActive: ReturnType<typeof vi.fn>;
  revokeActiveSessionsOfUser: ReturnType<typeof vi.fn>;
}

function build() {
  const repository: RepositoryStub = {
    createSession: vi.fn(async () => undefined),
    createToken: vi.fn(async () => undefined),
    slideExpiry: vi.fn(async () => true),
    markUsed: vi.fn(async () => 1),
    deleteUsedTokensBefore: vi.fn(async () => 0),
    findToken: vi.fn(async () => null),
    hasTokenUsedAfter: vi.fn(async () => true),
    deleteUnusedTokens: vi.fn(async () => 0),
    revokeSession: vi.fn(async () => 'owner-id'),
    revokeOwnedSession: vi.fn(async () => true),
    isSessionActive: vi.fn(async () => true),
    revokeActiveSessionsOfUser: vi.fn(async () => ['s2', 's3']),
  };
  const txManager = {
    run: vi.fn((fn: () => Promise<unknown>) => fn()),
    getClient: vi.fn(),
    isInTransaction: vi.fn(() => false),
  };
  const service = new AuthSessionService(
    repository as unknown as PrismaAuthSessionRepository,
    txManager as unknown as ITransactionManager,
  );
  return { service, repository, txManager };
}

function token(overrides: Partial<RefreshTokenDomain> = {}): RefreshTokenDomain {
  return { id: 't1', sessionId: 's1', createdAt: at(0), usedAt: null, usedUaHash: null, ...overrides };
}

/** The client every case presents unless it overrides one; `uaHash` is what a recovery must match. */
const CLIENT = { uaHash: 'ua-hash-1', ip: '198.51.100.9' };

const rotateInput = (overrides: Partial<Parameters<AuthSessionService['rotate']>[0]> = {}) => ({
  sessionId: 's1',
  presentedTokenId: 't1',
  nextTokenId: 't2',
  nextExpiresAt: at(7 * 24 * 60 * 60 * 1000),
  now: at(1_000),
  client: CLIENT,
  ...overrides,
});

describe('AuthSessionService', () => {
  it('returns the ids revoked for a user without opening a transaction', async () => {
    const { service, repository, txManager } = build();
    await expect(service.revokeAllForUser('u1', 'password-change', t0, 's1')).resolves.toEqual(['s2', 's3']);
    expect(repository.revokeActiveSessionsOfUser).toHaveBeenCalledWith('u1', 'password-change', t0, 's1');
    expect(txManager.run).not.toHaveBeenCalled();
  });

  it('starts a session and its first token in one transaction', async () => {
    const { service, repository, txManager } = build();
    const expiresAt = at(7 * 24 * 60 * 60 * 1000);

    await service.start({ userId: 'u1', sessionId: 's1', tokenId: 't1', expiresAt });

    expect(txManager.run).toHaveBeenCalledTimes(1);
    expect(repository.createSession).toHaveBeenCalledWith({ id: 's1', userId: 'u1', expiresAt });
    expect(repository.createToken).toHaveBeenCalledWith({ id: 't1', sessionId: 's1' });
  });

  it('rotates an unused token: slides, marks it used, inserts the next and cleans old used tokens', async () => {
    const { service, repository, txManager } = build();
    const input = rotateInput();

    await expect(service.rotate(input)).resolves.toEqual({ kind: 'rotated' });

    expect(txManager.run).toHaveBeenCalledTimes(1);
    expect(repository.slideExpiry).toHaveBeenCalledWith('s1', input.nextExpiresAt, input.now);
    // auth-passwords US-005: the first use records the client that presented the token.
    expect(repository.markUsed).toHaveBeenCalledWith('s1', 't1', input.now, input.client);
    expect(repository.createToken).toHaveBeenCalledWith({ id: 't2', sessionId: 's1', createdAt: input.now });
    expect(repository.deleteUsedTokensBefore).toHaveBeenCalledWith(
      's1',
      new Date(input.now.getTime() - REFRESH_REUSE_GRACE_MS),
    );
    expect(repository.revokeSession).not.toHaveBeenCalled();
  });

  it('answers invalid, writing nothing, when the slide matches no live session', async () => {
    const { service, repository } = build();
    repository.slideExpiry.mockResolvedValue(false);

    await expect(service.rotate(rotateInput())).resolves.toEqual({ kind: 'invalid' });

    expect(repository.markUsed).not.toHaveBeenCalled();
    expect(repository.createToken).not.toHaveBeenCalled();
    expect(repository.deleteUsedTokensBefore).not.toHaveBeenCalled();
    expect(repository.revokeSession).not.toHaveBeenCalled();
  });

  it('rotates a token used exactly one grace window ago without revoking', async () => {
    const { service, repository } = build();
    const input = rotateInput();
    repository.markUsed.mockResolvedValue(0);
    repository.findToken.mockResolvedValue(
      token({ usedAt: new Date(input.now.getTime() - REFRESH_REUSE_GRACE_MS) }),
    );

    await expect(service.rotate(input)).resolves.toEqual({ kind: 'rotated' });

    expect(repository.findToken).toHaveBeenCalledWith('t1', 's1');
    expect(repository.createToken).toHaveBeenCalledWith({ id: 't2', sessionId: 's1', createdAt: input.now });
    expect(repository.revokeSession).not.toHaveBeenCalled();
  });

  it('revokes and answers reused when the token was used before the grace window and a later token was used', async () => {
    const { service, repository } = build();
    const input = rotateInput();
    const usedAt = new Date(input.now.getTime() - REFRESH_REUSE_GRACE_MS - 1_000);
    repository.markUsed.mockResolvedValue(0);
    // The same client presents it again, so the decision is the later use, not the binding (US-005).
    repository.findToken.mockResolvedValue(token({ usedAt, usedUaHash: CLIENT.uaHash }));
    repository.hasTokenUsedAfter.mockResolvedValue(true);

    await expect(service.rotate(input)).resolves.toEqual({ kind: 'reused', userId: 'owner-id' });

    expect(repository.hasTokenUsedAfter).toHaveBeenCalledWith('s1', usedAt, 't1');
    expect(repository.revokeSession).toHaveBeenCalledWith('s1', 'reuse', input.now);
    expect(repository.createToken).not.toHaveBeenCalled();
    expect(repository.deleteUnusedTokens).not.toHaveBeenCalled();
  });

  it('re-rotates, without revoking, when the token was used before the grace window but no later token was used', async () => {
    // A lost response: the client never received the token this one was exchanged for, so it presents the
    // newest token it holds again. Its unreceived successors are dropped, so if the client did hold one,
    // presenting it later finds no row and revokes the session.
    const { service, repository } = build();
    const input = rotateInput();
    repository.markUsed.mockResolvedValue(0);
    repository.findToken.mockResolvedValue(
      token({
        usedAt: new Date(input.now.getTime() - REFRESH_REUSE_GRACE_MS - 1_000),
        usedUaHash: input.client.uaHash,
      }),
    );
    repository.hasTokenUsedAfter.mockResolvedValue(false);

    await expect(service.rotate(input)).resolves.toEqual({ kind: 'recovered', ip: input.client.ip });

    // Only successors older than the grace window go: a sibling a parallel retry just issued stays valid.
    expect(repository.deleteUnusedTokens).toHaveBeenCalledWith(
      's1',
      new Date(input.now.getTime() - REFRESH_REUSE_GRACE_MS),
    );
    expect(repository.createToken).toHaveBeenCalledWith({ id: 't2', sessionId: 's1', createdAt: input.now });
    expect(repository.revokeSession).not.toHaveBeenCalled();
    // The successors go before the next token is written, or the cleanup would drop it too.
    const deleted = repository.deleteUnusedTokens.mock.invocationCallOrder[0] ?? 0;
    const created = repository.createToken.mock.invocationCallOrder[0] ?? 0;
    expect(deleted).toBeLessThan(created);
  });

  it('AC-7: recovers a matching User-Agent with the presenting IP, even after an IP change', async () => {
    const { service, repository } = build();
    const client = { uaHash: 'matching-hash', ip: '198.51.100.9' };
    const input = { ...rotateInput(), client };
    repository.markUsed.mockResolvedValue(0);
    repository.findToken.mockResolvedValue({
      ...token({ usedAt: new Date(input.now.getTime() - 31_000) }),
      usedUaHash: client.uaHash,
      usedIp: '203.0.113.7',
    });
    repository.hasTokenUsedAfter.mockResolvedValue(false);

    await expect(service.rotate(input)).resolves.toEqual({ kind: 'recovered', ip: client.ip });
    expect(repository.revokeSession).not.toHaveBeenCalled();
  });

  it('AC-11: revokes a lost-response retry with a different User-Agent hash', async () => {
    const { service, repository } = build();
    const input = { ...rotateInput(), client: { uaHash: 'different-hash', ip: null } };
    repository.markUsed.mockResolvedValue(0);
    repository.findToken.mockResolvedValue({
      ...token({ usedAt: new Date(input.now.getTime() - 31_000) }),
      usedUaHash: 'original-hash',
    });
    repository.hasTokenUsedAfter.mockResolvedValue(false);

    await expect(service.rotate(input)).resolves.toEqual({ kind: 'reused', userId: 'owner-id' });
    expect(repository.revokeSession).toHaveBeenCalledWith('s1', 'reuse', input.now);
    expect(repository.createToken).not.toHaveBeenCalled();
  });

  it('AC-11 (cont.): a token first used before the migration carries no binding, so it is never recovered', async () => {
    const { service, repository } = build();
    const input = rotateInput();
    repository.markUsed.mockResolvedValue(0);
    repository.findToken.mockResolvedValue({
      ...token({ usedAt: new Date(input.now.getTime() - 31_000) }),
      usedUaHash: null,
    });
    repository.hasTokenUsedAfter.mockResolvedValue(false);

    // A null hash never matches: the token can be rotated on first use or refused, never recovered.
    await expect(service.rotate(input)).resolves.toEqual({ kind: 'reused', userId: 'owner-id' });
    expect(repository.revokeSession).toHaveBeenCalledWith('s1', 'reuse', input.now);
    expect(repository.deleteUnusedTokens).not.toHaveBeenCalled();
    expect(repository.createToken).not.toHaveBeenCalled();
  });

  it('AC-13 (unit): the grace window is not bound — a different User-Agent inside it still rotates', async () => {
    const { service, repository } = build();
    const input = rotateInput({ client: { uaHash: 'another-browser', ip: null } });
    repository.markUsed.mockResolvedValue(0);
    repository.findToken.mockResolvedValue(
      token({ usedAt: new Date(input.now.getTime() - REFRESH_REUSE_GRACE_MS), usedUaHash: CLIENT.uaHash }),
    );

    // Step 4 answers a parallel refresh of the same browser: only the recovery (step 5) is bound.
    await expect(service.rotate(input)).resolves.toEqual({ kind: 'rotated' });
    expect(repository.revokeSession).not.toHaveBeenCalled();
    expect(repository.createToken).toHaveBeenCalledWith({ id: 't2', sessionId: 's1', createdAt: input.now });
  });

  it('revokes, without re-rotating, a stale token used longer than the lost-response window ago', async () => {
    // The recovery is bounded: a browser that lost a response refreshes again within one access-token
    // lifetime, so a token idle past the window is treated as a replay even when nothing later was used.
    const { service, repository } = build();
    const input = rotateInput();
    repository.markUsed.mockResolvedValue(0);
    repository.findToken.mockResolvedValue(
      token({ usedAt: new Date(input.now.getTime() - LOST_RESPONSE_WINDOW_MS - 1_000) }),
    );
    repository.hasTokenUsedAfter.mockResolvedValue(false);

    await expect(service.rotate(input)).resolves.toEqual({ kind: 'reused', userId: 'owner-id' });

    expect(repository.revokeSession).toHaveBeenCalledWith('s1', 'reuse', input.now);
    expect(repository.deleteUnusedTokens).not.toHaveBeenCalled();
    expect(repository.createToken).not.toHaveBeenCalled();
  });

  it('revokes and answers reused when the presented token has no row', async () => {
    const { service, repository } = build();
    const input = rotateInput();
    repository.markUsed.mockResolvedValue(0);
    repository.findToken.mockResolvedValue(null);

    await expect(service.rotate(input)).resolves.toEqual({ kind: 'reused', userId: 'owner-id' });

    expect(repository.revokeSession).toHaveBeenCalledWith('s1', 'reuse', input.now);
  });

  it("keeps the start writes uncounted under the 'auth.session-start' reason", async () => {
    const { service, repository } = build();
    const seen: (string | undefined)[] = [];
    repository.createSession.mockImplementation(async () => {
      seen.push(currentBookkeepingReason());
    });
    repository.createToken.mockImplementation(async () => {
      seen.push(currentBookkeepingReason());
    });

    await openAuditScope('POST /auth/login', async (scope) => {
      await service.start({ userId: 'u1', sessionId: 's1', tokenId: 't1', expiresAt: at(1_000) });
      expect(scope.writes).toEqual([]);
      expect(scope.entries).toBe(0);
    });

    expect(seen).toEqual(['auth.session-start', 'auth.session-start']);
  });

  it("keeps the rotation writes uncounted under the 'auth.session-rotate' reason", async () => {
    const { service, repository } = build();
    const seen: (string | undefined)[] = [];
    const note = () => {
      seen.push(currentBookkeepingReason());
    };
    repository.slideExpiry.mockImplementation(async () => {
      note();
      return true;
    });
    repository.markUsed.mockImplementation(async () => {
      note();
      return 1;
    });
    repository.createToken.mockImplementation(async () => {
      note();
    });
    repository.deleteUsedTokensBefore.mockImplementation(async () => {
      note();
      return 0;
    });

    await openAuditScope('POST /auth/refresh', async (scope) => {
      await service.rotate(rotateInput());
      expect(scope.writes).toEqual([]);
      expect(scope.entries).toBe(0);
    });

    expect(seen).toEqual([
      'auth.session-rotate',
      'auth.session-rotate',
      'auth.session-rotate',
      'auth.session-rotate',
    ]);
  });

  // auth-sessions US-003: `revoke` opens no transaction and records nothing — its caller (logout)
  // owns both — so it forwards straight to the repository's owner-checked conditional update.
  describe('revoke', () => {
    it('revokes the owner-checked, not-yet-revoked session and answers the repository result', async () => {
      const { service, repository, txManager } = build();

      await expect(service.revoke('s1', 'u1', 'logout', at(1_000))).resolves.toBe(true);

      expect(repository.revokeOwnedSession).toHaveBeenCalledWith('s1', 'u1', 'logout', at(1_000));
      // No bookkeeping wrapper and no transaction: the caller's `audited` transaction is the unit.
      expect(txManager.run).not.toHaveBeenCalled();
      expect(currentBookkeepingReason()).toBeUndefined();
    });

    it('answers false when the conditional update matched nothing', async () => {
      const { service, repository } = build();
      repository.revokeOwnedSession.mockResolvedValue(false);

      await expect(service.revoke('s1', 'u2', 'logout', at(1_000))).resolves.toBe(false);
    });
  });

  // auth-sessions US-003: the access-token activity check is a plain read; no write, no transaction.
  describe('isActive', () => {
    it('asks the repository whether the session is live at now', async () => {
      const { service, repository, txManager } = build();

      await expect(service.isActive('s1', at(1_000))).resolves.toBe(true);

      expect(repository.isSessionActive).toHaveBeenCalledWith('s1', at(1_000));
      expect(txManager.run).not.toHaveBeenCalled();
    });

    it('answers false for a session the repository does not consider live', async () => {
      const { service, repository } = build();
      repository.isSessionActive.mockResolvedValue(false);

      await expect(service.isActive('s1', at(1_000))).resolves.toBe(false);
    });
  });
});
