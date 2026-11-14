/**
 * auth-sessions US-001 — the durable session store and atomic refresh rotation on real Postgres.
 *
 * The store is asserted through `AuthSessionService`, never through the repository, so the tests pin the
 * contract the follow-up stories call. Writes run under a real actor context (the API client refuses a
 * context-less write) and every `now` is explicit, so the grace-window boundaries and the used-token
 * cleanup are decided by the value the test passes, not by the clock.
 *
 * Run: cd apps/api && bun run test:db:up && bun run test:scoped test/integration/auth/auth-sessions.integration.spec.ts
 */
import { Test, TestingModule } from '@nestjs/testing';
import { PrismaModule, PrismaService } from '@nathapp/nestjs-prisma';
import { PrismaClient } from '../../../src/generated/prisma/client';
import { KodaPrismaClient } from '../../../src/prisma/koda-prisma-client';
import { createPgAdapter } from '../../../src/prisma/pg-adapter';
import {
  AuthSessionService,
  REFRESH_REUSE_GRACE_MS,
} from '../../../src/auth/sessions/auth-session.service';
import { PrismaAuthSessionRepository } from '../../../src/auth/sessions/prisma-auth-session.repository';
import { AUTH_SESSION_REPOSITORY } from '../../../src/auth/sessions/auth-session.domain';
import { canRunDbTests } from '../../helpers/test-environment';
import { fixtureDb, withTestActor } from '../../helpers/action-context';
import { resetDb } from '../../helpers/reset-db';

const describeIntegration = canRunDbTests() ? describe : describe.skip;

const TIMEOUT = 30_000;
const DATABASE_URL = process.env.DATABASE_URL;

const t0 = new Date('2026-12-10T09:00:00.000Z');
/** `t0` plus `ms`, so every instant a test uses is explicit. */
const at = (ms: number): Date => new Date(t0.getTime() + ms);

const WEEK = 7 * 24 * 60 * 60 * 1000;
const GRACE = REFRESH_REUSE_GRACE_MS;

describeIntegration('auth sessions store (PG)', () => {
  let module: TestingModule;
  let prisma: PrismaService<PrismaClient>;
  let sessions: AuthSessionService;
  let db: ReturnType<typeof fixtureDb>;

  const userId = 'session-user';
  const actor = { type: 'USER', id: userId } as const;

  /** Every service call runs as a user actor, the way a request does. */
  const asUser = <T>(fn: () => T | PromiseLike<T>): Promise<T> => withTestActor(actor, fn);

  beforeAll(async () => {
    await resetDb();
    module = await Test.createTestingModule({
      imports: [
        PrismaModule.forRoot({
          // The API's client, so the context-less write guard stays in force in these tests.
          client: KodaPrismaClient,
          transaction: true,
          clientOptions: { adapter: createPgAdapter(DATABASE_URL) },
        }),
      ],
      providers: [
        PrismaAuthSessionRepository,
        { provide: AUTH_SESSION_REPOSITORY, useExisting: PrismaAuthSessionRepository },
        AuthSessionService,
      ],
    }).compile();
    prisma = module.get(PrismaService);
    await prisma.onModuleInit();
    sessions = module.get(AuthSessionService);
    db = fixtureDb(module);
  }, TIMEOUT);

  afterAll(async () => {
    await prisma?.onModuleDestroy();
    await module?.close();
  }, TIMEOUT);

  beforeEach(async () => {
    await resetDb();
    await db.user.create({
      data: { id: userId, email: 'sessions@example.test', name: 'Session User', passwordHash: 'hash' },
    });
  }, TIMEOUT);

  /** Starts a session whose refresh token `t1` is unused and whose expiry is a week out. */
  const startSession = async (sessionId = 's1', tokenId = 't1', expiresAt = at(WEEK)): Promise<void> => {
    await asUser(() => sessions.start({ userId, sessionId, tokenId, expiresAt }));
  };

  const rotate = (
    input: { sessionId?: string; presentedTokenId: string; nextTokenId: string; now: Date; nextExpiresAt?: Date },
  ) =>
    asUser(() =>
      sessions.rotate({
        sessionId: input.sessionId ?? 's1',
        presentedTokenId: input.presentedTokenId,
        nextTokenId: input.nextTokenId,
        nextExpiresAt: input.nextExpiresAt ?? at(WEEK + input.now.getTime() - t0.getTime()),
        now: input.now,
      }),
    );

  const sessionRow = (sessionId = 's1') => db.authSession.findUnique({ where: { id: sessionId } });
  const tokenRows = (sessionId = 's1') =>
    db.refreshToken.findMany({ where: { sessionId }, orderBy: { id: 'asc' } });

  it('AC-1: start inserts the session with its user and expiry, holding exactly one unused token', async () => {
    await startSession('s1', 't1', at(WEEK));

    expect(await sessionRow()).toMatchObject({ id: 's1', userId, expiresAt: at(WEEK) });
    expect(await tokenRows()).toMatchObject([{ id: 't1', sessionId: 's1', usedAt: null }]);
  }, TIMEOUT);

  it('AC-2, AC-3 and AC-4: an unused presented token rotates, is marked used and slides the expiry', async () => {
    await startSession();
    const now = at(1_000);
    const nextExpiresAt = at(WEEK + 1_000);

    await expect(rotate({ presentedTokenId: 't1', nextTokenId: 't2', now, nextExpiresAt })).resolves.toEqual({
      kind: 'rotated',
    });

    // AC-3: the presented token carries the rotation's `now` as its used mark.
    expect(await db.refreshToken.findUnique({ where: { id: 't1' } })).toMatchObject({ usedAt: now });
    // AC-4: the session expiry follows the newest token.
    expect(await sessionRow()).toMatchObject({ expiresAt: nextExpiresAt, revokedAt: null });
  }, TIMEOUT);

  it('AC-5: three rotations 31 seconds apart leave the last presented token and the newest one', async () => {
    await startSession();

    await rotate({ presentedTokenId: 't1', nextTokenId: 't2', now: at(1_000) });
    await rotate({ presentedTokenId: 't2', nextTokenId: 't3', now: at(1_000 + 31_000) });
    await rotate({ presentedTokenId: 't3', nextTokenId: 't4', now: at(1_000 + 2 * 31_000) });

    const rows = await tokenRows();
    expect(rows.map((row) => row.id)).toEqual(['t3', 't4']);
    // The newest token is unused: it is the one the browser holds and may present next.
    expect(rows.find((row) => row.id === 't4')?.usedAt).toBeNull();
  }, TIMEOUT);

  it('AC-6: a token used exactly one grace window ago rotates without revoking the session', async () => {
    await startSession();
    const now = at(100_000);
    // Present t1 exactly one grace window before `now`, so t1's used mark is `now - 30s`.
    await rotate({ presentedTokenId: 't1', nextTokenId: 't2', now: new Date(now.getTime() - GRACE) });

    await expect(rotate({ presentedTokenId: 't1', nextTokenId: 't3', now })).resolves.toEqual({ kind: 'rotated' });

    expect(await sessionRow()).toMatchObject({ revokedAt: null, revokedReason: null });
    expect(await db.refreshToken.findUnique({ where: { id: 't3' } })).toMatchObject({ usedAt: null });
  }, TIMEOUT);

  it('AC-7 and AC-8: a token used 31 seconds ago is reuse, and it revokes the session', async () => {
    await startSession();
    const now = at(100_000);
    const presentedUsedAt = new Date(now.getTime() - (GRACE + 1_000));
    await rotate({ presentedTokenId: 't1', nextTokenId: 't2', now: presentedUsedAt });

    await expect(rotate({ presentedTokenId: 't1', nextTokenId: 't3', now })).resolves.toEqual({
      kind: 'reused',
      userId,
    });

    expect(await sessionRow()).toMatchObject({ revokedAt: now, revokedReason: 'reuse' });
  }, TIMEOUT);

  it('AC-9: an unknown presented token is reuse for a live session', async () => {
    await startSession();

    await expect(rotate({ presentedTokenId: 'no-such-token', nextTokenId: 't2', now: at(1_000) })).resolves.toEqual({
      kind: 'reused',
      userId,
    });
  }, TIMEOUT);

  it('AC-10: a revoked session answers invalid and writes no token', async () => {
    await startSession();
    await db.authSession.update({ where: { id: 's1' }, data: { revokedAt: at(500), revokedReason: 'logout' } });

    await expect(rotate({ presentedTokenId: 't1', nextTokenId: 't2', now: at(1_000) })).resolves.toEqual({
      kind: 'invalid',
    });

    expect((await tokenRows()).map((row) => row.id)).toEqual(['t1']);
    expect(await db.refreshToken.findUnique({ where: { id: 't1' } })).toMatchObject({ usedAt: null });
  }, TIMEOUT);

  it('AC-11: a session expiring at or before now answers invalid', async () => {
    await startSession('s-equal', 't-equal', at(1_000));
    await startSession('s-past', 't-past', at(500));

    await expect(
      rotate({ sessionId: 's-equal', presentedTokenId: 't-equal', nextTokenId: 't2', now: at(1_000) }),
    ).resolves.toEqual({ kind: 'invalid' });
    await expect(
      rotate({ sessionId: 's-past', presentedTokenId: 't-past', nextTokenId: 't3', now: at(1_000) }),
    ).resolves.toEqual({ kind: 'invalid' });

    expect(await tokenRows('s-equal')).toHaveLength(1);
    expect(await tokenRows('s-past')).toHaveLength(1);
  }, TIMEOUT);

  it('AC-12 and AC-13: two concurrent rotations of one token both succeed, and both tokens rotate later', async () => {
    await startSession();
    const now = at(1_000);

    await expect(
      asUser(() =>
        Promise.all([
          sessions.rotate({ sessionId: 's1', presentedTokenId: 't1', nextTokenId: 't2', nextExpiresAt: at(WEEK), now }),
          sessions.rotate({ sessionId: 's1', presentedTokenId: 't1', nextTokenId: 't3', nextExpiresAt: at(WEEK), now }),
        ]),
      ),
    ).resolves.toEqual([{ kind: 'rotated' }, { kind: 'rotated' }]);
    // Both issued a token, and both siblings are unused — which is what makes either usable next.
    const siblings = (await tokenRows()).filter((row) => row.id === 't2' || row.id === 't3');
    expect(siblings.map((row) => row.id)).toEqual(['t2', 't3']);
    expect(siblings.map((row) => row.usedAt)).toEqual([null, null]);
    expect(await sessionRow()).toMatchObject({ revokedAt: null });

    // AC-13: the sibling each concurrent refresh issued stays usable.
    await expect(rotate({ presentedTokenId: 't2', nextTokenId: 't4', now: at(2_000) })).resolves.toEqual({
      kind: 'rotated',
    });
    await expect(rotate({ presentedTokenId: 't3', nextTokenId: 't5', now: at(3_000) })).resolves.toEqual({
      kind: 'rotated',
    });
  }, TIMEOUT);
});
