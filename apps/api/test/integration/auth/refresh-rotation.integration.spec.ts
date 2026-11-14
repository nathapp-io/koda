/**
 * auth-sessions US-004 — durable refresh rotation, legacy refusal and reuse revocation on real Postgres.
 *
 * Every case goes through the booted API (so a wiring break in `AuthService`/`AuthSessionService` fails
 * the boot) and asserts the durable state, never a stub: a rotation is only correct if the token row it
 * spent, the token row it minted and the single session row it slid agree.
 *
 * Each case logs in as its own user, so "exactly one session" and "no rows written" are counts on a user
 * nobody else touched.
 *
 * Run: cd apps/api && bun run test:db:up && KODA_DB_TESTS=1 npx vitest run test/integration/auth/refresh-rotation.integration.spec.ts
 */
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import * as bcrypt from 'bcrypt';
import request from 'supertest';
import { vi } from 'vitest';
import { NathApplication } from '@nathapp/nestjs-app';
import { JwtRefreshStrategyProvider } from '@nathapp/nestjs-auth';
import { PrismaClient } from '../../../src/generated/prisma/client';
import { canRunDbTests } from '../../helpers/test-environment';
import { resetDb } from '../../helpers/reset-db';
import { bootHttpApp, data, resetThrottle, TEST_PASSWORD } from '../../helpers/http-app';
import { fixtureDb } from '../../helpers/action-context';
import { grantBaseline } from '../../../src/permissions/test-helpers/permission-fixtures';
import { AuthSessionService } from '../../../src/auth/sessions/auth-session.service';

const describeIntegration = canRunDbTests() ? describe : describe.skip;

const TIMEOUT = 30_000;

/** `auth.40000`, the sentence a 401 `auth` refusal carries. */
const AUTH_REFUSED = (JSON.parse(
  readFileSync(join(__dirname, '../../../src/i18n/en/auth.json'), 'utf8'),
) as Record<string, string>)['40000'];

interface TokenPair {
  accessToken: string;
  refreshToken: string;
}

/** A signed JWT's claims, without verifying it: these cases only need the ids it names. */
const claims = (token: string): Record<string, unknown> =>
  JSON.parse(Buffer.from(token.split('.')[1] ?? '', 'base64url').toString()) as Record<string, unknown>;

describeIntegration('refresh rotation (PG)', () => {
  let app: NathApplication;
  let db: PrismaClient;
  let server: ReturnType<NathApplication['getHttpServer']>;
  let refreshSigner: JwtRefreshStrategyProvider;
  let sessions: AuthSessionService;

  /** A fresh user per case, with the baseline binding every user gets, and its login pair. */
  const newUserWithSession = async (): Promise<{ userId: string; pair: TokenPair }> => {
    const email = `refresh-rotation-${randomUUID()}@koda.test`;
    const user = await db.user.create({
      data: { email, name: 'Refresh Rotation', passwordHash: await bcrypt.hash(TEST_PASSWORD, 4) },
    });
    await grantBaseline(db, { type: 'USER', id: user.id });
    const res = await request(server).post('/api/auth/login').send({ email, password: TEST_PASSWORD }).expect(200);
    return { userId: user.id, pair: data<TokenPair>(res) };
  };

  const refresh = (refreshToken: string) =>
    request(server).post('/api/auth/refresh').set('Authorization', `Bearer ${refreshToken}`);

  const me = async (accessToken: string): Promise<number> =>
    (await request(server).get('/api/auth/me').set('Authorization', `Bearer ${accessToken}`)).status;

  const sessionIdOf = (pair: TokenPair): string => {
    const sid = claims(pair.refreshToken)['sid'];
    if (typeof sid !== 'string') throw new Error('refresh token carries no sid');
    return sid;
  };

  const tokenIdOf = (pair: TokenPair): string => {
    const jti = claims(pair.refreshToken)['jti'];
    if (typeof jti !== 'string') throw new Error('refresh token carries no jti');
    return jti;
  };

  const userRow = (id: string) => db.user.findUniqueOrThrow({ where: { id } });

  /** A promise that stays pending until `resolve` is called — how the paused-lookup case holds a fill open. */
  const deferred = (): { promise: Promise<void>; resolve: () => void } => {
    let resolve!: () => void;
    const promise = new Promise<void>((res) => { resolve = res; });
    return { promise, resolve };
  };

  /** Polls until `condition` holds, so a case never has to sleep for an unknown duration. */
  const waitFor = async (condition: () => Promise<boolean>, timeoutMs = 5_000): Promise<void> => {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (await condition()) return;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    throw new Error('condition did not hold before the deadline');
  };

  beforeAll(async () => {
    await resetDb();
    app = await bootHttpApp({ registrationEnabled: false });
    server = app.getHttpServer();
    db = fixtureDb(app);
    refreshSigner = app.get(JwtRefreshStrategyProvider);
    sessions = app.get(AuthSessionService);
  }, TIMEOUT);

  afterAll(async () => {
    await app?.close();
  });

  // Every case logs in; the login route is throttled at 5/min per address.
  beforeEach(() => {
    resetThrottle(app);
  });

  it('AC-1: refresh answers 200 with a refresh JWT whose jti differs from the presented one', async () => {
    const { pair } = await newUserWithSession();
    const presentedTokenId = tokenIdOf(pair);

    const rotated = data<TokenPair>(await refresh(pair.refreshToken).expect(200));

    expect(claims(rotated.refreshToken)['jti']).toEqual(expect.any(String));
    expect(claims(rotated.refreshToken)['jti']).not.toBe(presentedTokenId);
    expect(claims(rotated.refreshToken)['sid']).toBe(sessionIdOf(pair));
  }, TIMEOUT);

  it('AC-2: that refresh leaves the user with exactly one AuthSession row', async () => {
    const { userId, pair } = await newUserWithSession();
    expect(await db.authSession.count({ where: { userId } })).toBe(1);

    const rotated = data<TokenPair>(await refresh(pair.refreshToken).expect(200));

    expect(await db.authSession.count({ where: { userId } })).toBe(1);
    // The surviving row is the one that was continued, not a replacement carrying the same shape.
    expect(sessionIdOf(rotated)).toBe(sessionIdOf(pair));
    expect(await db.authSession.findUniqueOrThrow({ where: { id: sessionIdOf(pair) } }))
      .toMatchObject({ revokedAt: null, revokedReason: null });
  }, TIMEOUT);

  it("AC-3: after that refresh, the presented token's row has usedAt set", async () => {
    const { pair } = await newUserWithSession();

    await refresh(pair.refreshToken).expect(200);

    const presented = await db.refreshToken.findUniqueOrThrow({ where: { id: tokenIdOf(pair) } });
    expect(presented.usedAt).toBeInstanceOf(Date);
    expect(presented.sessionId).toBe(sessionIdOf(pair));
  }, TIMEOUT);

  it('AC-4/5/6/7: a replay after the grace window is refused, revokes the session and is audited', async () => {
    const { userId, pair } = await newUserWithSession();
    const rotated = data<TokenPair>(await refresh(pair.refreshToken).expect(200));

    // The reuse must be outside the 30 s window; backdating the fixture is how the case avoids sleeping.
    const presentedId = tokenIdOf(pair);
    const usedAt = new Date(Date.now() - 31_000);
    await db.refreshToken.update({ where: { id: presentedId }, data: { usedAt } });

    // AC-7: warm the 60 s session-activity cache, so the later 401 proves the direct-key eviction.
    expect(await me(rotated.accessToken)).toBe(200);

    // AC-4
    const replay = await refresh(pair.refreshToken);
    expect(replay.status).toBe(401);
    expect(replay.body.ret).toBe(40000);
    expect(replay.body.message).toBe(AUTH_REFUSED);

    // AC-5: the revocation is on the record, attributed to the user whose session was revoked.
    const entries = await db.auditEntry.findMany({ where: { key: 'session.refresh', resourceId: userId } });
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      key: 'session.refresh',
      resourceType: 'user',
      resourceId: userId,
      projectId: null,
      summary: 'refresh token reuse; session revoked',
    });

    // AC-6: the newest token of that session died with it.
    await refresh(rotated.refreshToken).expect(401);

    // AC-7: so did the access token that was still accepted before the reuse.
    expect(await me(rotated.accessToken)).toBe(401);
  }, TIMEOUT);

  // Branch fix B1: the 60 s activity fill and the reuse eviction share one per-session lock, so a lookup
  // that read the session while it was still live cannot write that answer into the cache after the reuse
  // revocation evicted it — which would keep the revoked access token working for the rest of the TTL.
  it('AC-7 (paused lookup): a fill paused across the reuse revocation cannot re-cache the live answer', async () => {
    const { pair } = await newUserWithSession();
    const rotated = data<TokenPair>(await refresh(pair.refreshToken).expect(200));
    const sessionId = sessionIdOf(pair);
    await db.refreshToken.update({ where: { id: tokenIdOf(pair) }, data: { usedAt: new Date(Date.now() - 31_000) } });

    const entered = deferred();
    const gate = deferred();
    const realIsActive = sessions.isActive.bind(sessions);
    const pause = vi.spyOn(sessions, 'isActive').mockImplementation(async (id, now) => {
      // The store read completes while the session is still live, then the fill is held open.
      const active = await realIsActive(id, now);
      entered.resolve();
      await gate.promise;
      return active;
    });

    try {
      const inFlight = (async () => (await request(server).get('/api/auth/me')
        .set('Authorization', `Bearer ${rotated.accessToken}`)).status)();
      await entered.promise;

      // The refresh route does not read session activity, so it revokes and then waits on the paused fill
      // for the cache eviction (the fence). Supertest starts a request when it is awaited, hence the IIFE.
      const replay = (async () => await refresh(pair.refreshToken))();
      await waitFor(async () => (await db.authSession.findUniqueOrThrow({ where: { id: sessionId } })).revokedReason === 'reuse');

      gate.resolve();
      const [replayResult] = await Promise.all([replay, inFlight]);

      expect(replayResult.status).toBe(401);
    } finally {
      gate.resolve();
      pause.mockRestore();
    }

    expect(await me(rotated.accessToken)).toBe(401);
  }, TIMEOUT);

  it('AC-8/9: a refresh token without sid/jti answers 401 and writes nothing', async () => {
    const { userId, pair } = await newUserWithSession();
    const before = await userRow(userId);
    const sessionsBefore = await db.authSession.count();
    const tokensBefore = await db.refreshToken.count();
    const legacy = refreshSigner.sign({ sub: userId, tokenVersion: before.tokenVersion });

    const res = await refresh(legacy);

    expect(res.status).toBe(401);
    expect(res.body.ret).toBe(40000);
    expect(res.body.message).toBe(AUTH_REFUSED);
    // AC-9: no session and no token row — the legacy token is refused before any write.
    expect(await db.authSession.count()).toBe(sessionsBefore);
    expect(await db.refreshToken.count()).toBe(tokensBefore);
    expect((await userRow(userId)).tokenVersion).toBe(before.tokenVersion);
    // The session the user does hold is untouched, so the client can still rotate it.
    await refresh(pair.refreshToken).expect(200);
  }, TIMEOUT);

  it('AC-10/11: two concurrent refreshes of one unused token both answer 200 and both pairs rotate', async () => {
    const { pair } = await newUserWithSession();

    // AC-10: the web client refreshes in parallel, so the same token is presented twice at once.
    const [first, second] = await Promise.all([
      refresh(pair.refreshToken),
      refresh(pair.refreshToken),
    ]);
    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    const firstPair = data<TokenPair>(first);
    const secondPair = data<TokenPair>(second);

    // AC-11: whichever pair the browser cookie keeps, that chain still rotates.
    const firstAgain = await refresh(firstPair.refreshToken);
    const secondAgain = await refresh(secondPair.refreshToken);
    expect(firstAgain.status).toBe(200);
    expect(secondAgain.status).toBe(200);
    // The session survived: neither response revoked it.
    expect((await db.authSession.findUniqueOrThrow({ where: { id: sessionIdOf(pair) } })).revokedAt).toBeNull();
  }, TIMEOUT);

  it('AC-12: after logout, refresh with that session\'s newest refresh token answers 401', async () => {
    const { pair } = await newUserWithSession();
    const rotated = data<TokenPair>(await refresh(pair.refreshToken).expect(200));

    await request(server).post('/api/auth/logout').set('Authorization', `Bearer ${rotated.accessToken}`).expect(200);

    await refresh(rotated.refreshToken).expect(401);
  }, TIMEOUT);

  it('AC-14: a refresh naming an unknown or expired session answers 401 and records no reuse entry', async () => {
    const { userId, pair } = await newUserWithSession();
    const user = await userRow(userId);

    const unknownSid = refreshSigner.sign({
      sub: userId, tokenVersion: user.tokenVersion, sid: randomUUID(), jti: randomUUID(),
    });
    const unknown = await refresh(unknownSid);
    expect(unknown.status).toBe(401);
    expect(unknown.body.ret).toBe(40000);
    expect(unknown.body.message).toBe(AUTH_REFUSED);

    // An expired session is `invalid` by the same conditional slide.
    const expiredSessionId = randomUUID();
    await db.authSession.create({
      data: {
        id: expiredSessionId,
        userId,
        expiresAt: new Date(Date.now() - 60_000),
      },
    });
    const expired = await refresh(refreshSigner.sign({
      sub: userId, tokenVersion: user.tokenVersion, sid: expiredSessionId, jti: randomUUID(),
    }));
    expect(expired.status).toBe(401);
    expect(expired.body.ret).toBe(40000);
    expect(expired.body.message).toBe(AUTH_REFUSED);

    // A dead or unknown session is not evidence of theft: no reuse entry, and no revocation to audit.
    expect(await db.auditEntry.count({ where: { key: 'session.refresh', resourceId: userId } })).toBe(0);
    expect((await db.authSession.findUniqueOrThrow({ where: { id: sessionIdOf(pair) } })).revokedAt).toBeNull();
  }, TIMEOUT);

  it('AC-15: an unknown jti for a live session is treated as reuse, not invalid', async () => {
    const { pair } = await newUserWithSession();
    const sessionId = sessionIdOf(pair);
    const user = await userRow((await db.authSession.findUniqueOrThrow({ where: { id: sessionId } })).userId);

    // The access token is still accepted, so the 401 below proves the eviction, not an uncached read.
    expect(await me(pair.accessToken)).toBe(200);

    const res = await refresh(refreshSigner.sign({
      sub: user.id, tokenVersion: user.tokenVersion, sid: sessionId, jti: randomUUID(),
    }));

    expect(res.status).toBe(401);
    expect(res.body.ret).toBe(40000);
    expect(res.body.message).toBe(AUTH_REFUSED);
    // The live session was revoked as a reuse, and its cached activity died with it.
    const session = await db.authSession.findUniqueOrThrow({ where: { id: sessionId } });
    expect(session.revokedReason).toBe('reuse');
    expect(session.revokedAt).not.toBeNull();
    expect(await me(pair.accessToken)).toBe(401);
  }, TIMEOUT);

  it('AC-15 (cont.): the audit entry of an unknown-jti reuse names the session owner', async () => {
    const { userId, pair } = await newUserWithSession();
    const user = await userRow(userId);

    await refresh(refreshSigner.sign({
      sub: userId, tokenVersion: user.tokenVersion, sid: sessionIdOf(pair), jti: randomUUID(),
    })).expect(401);

    const entries = await db.auditEntry.findMany({ where: { key: 'session.refresh', resourceId: userId } });
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      resourceType: 'user', projectId: null, summary: 'refresh token reuse; session revoked',
    });
  }, TIMEOUT);
});
