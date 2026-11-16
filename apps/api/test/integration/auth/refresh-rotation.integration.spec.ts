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
import { createHash, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import * as bcrypt from 'bcrypt';
import request from 'supertest';
import { vi } from 'vitest';
import { NathApplication } from '@nathapp/nestjs-app';
import { JwtRefreshStrategyProvider } from '@nathapp/nestjs-auth';
import { configureTrustProxy, resetTrustProxyConfig } from '@nathapp/nestjs-common';
import { PrismaClient } from '../../../src/generated/prisma/client';
import { canRunDbTests } from '../../helpers/test-environment';
import { resetDb } from '../../helpers/reset-db';
import { bootHttpApp, data, resetThrottle, TEST_PASSWORD } from '../../helpers/http-app';
import { fixtureDb } from '../../helpers/action-context';
import { grantBaseline } from '../../../src/permissions/test-helpers/permission-fixtures';
import { AuthSessionService, LOST_RESPONSE_WINDOW_MS } from '../../../src/auth/sessions/auth-session.service';
import { TRUSTED_PROXIES } from '../../../src/common/trusted-proxies';

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

/** The sha256 hex the first use must store for a User-Agent, computed without the production helper. */
const sha256 = (value: string): string => createHash('sha256').update(value).digest('hex');

/** The summary every lost-response recovery records: the presenting IP is part of the entry. */
const RECOVERY_SUMMARY = /^refresh token lost-response recovery; session kept; ip \S+$/;

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

  /**
   * Presents a refresh token; `userAgent` is the header the client sends (auth-passwords US-005) and
   * `clientIp`, when given, is what the Nuxt proxy sends on the browser's behalf — the same address in
   * both client headers (#470).
   */
  const refresh = (refreshToken: string, userAgent?: string, clientIp?: string) => {
    const call = request(server).post('/api/auth/refresh').set('Authorization', `Bearer ${refreshToken}`);
    if (userAgent !== undefined) call.set('User-Agent', userAgent);
    if (clientIp !== undefined) call.set('X-Forwarded-For', clientIp).set('X-Client-Ip', clientIp);
    return call;
  };

  /**
   * #470: production enables trust proxy from `TRUSTED_PROXIES` in `main.ts`; the harness deliberately does
   * not, so a case that exercises a forwarded address configures that same list and `afterEach` restores it.
   */
  const trustTheWebProxy = (): void => {
    configureTrustProxy({ enabled: true, trustedProxies: TRUSTED_PROXIES });
  };

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

  // Trust proxy is process-wide module state: a case that configures it must not leak into the next one.
  afterEach(() => {
    resetTrustProxyConfig();
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
    // The client moved on: it used the successor too, so a replay of the first token is not a lost response.
    const second = data<TokenPair>(await refresh(pair.refreshToken).expect(200));
    const rotated = data<TokenPair>(await refresh(second.refreshToken).expect(200));

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

  /** Backdates a token's use and its undelivered successor's issue, as a refresh 31 s ago would leave them. */
  const ageExchange = async (presented: TokenPair, successor: TokenPair, ageMs = 31_000): Promise<void> => {
    const at = new Date(Date.now() - ageMs);
    await db.refreshToken.update({ where: { id: tokenIdOf(presented) }, data: { usedAt: at } });
    await db.refreshToken.update({ where: { id: tokenIdOf(successor) }, data: { createdAt: at } });
  };

  it('lost response: a replay after the grace window whose successor was never used re-rotates instead of revoking', async () => {
    const { userId, pair } = await newUserWithSession();
    // The successor never reaches the client (a navigation aborted the refresh after the API committed it).
    const lost = data<TokenPair>(await refresh(pair.refreshToken, 'UA-1').expect(200));
    await ageExchange(pair, lost);

    const resent = data<TokenPair>(await refresh(pair.refreshToken, 'UA-1').expect(200));

    expect(sessionIdOf(resent)).toBe(sessionIdOf(pair));
    expect(await db.authSession.findUniqueOrThrow({ where: { id: sessionIdOf(pair) } }))
      .toMatchObject({ revokedAt: null, revokedReason: null });
    expect(await me(resent.accessToken)).toBe(200);
    // The recovery is on the record: a thief replaying a stolen newest token would take this path too.
    const entries = await db.auditEntry.findMany({ where: { key: 'session.refresh', resourceId: userId } });
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ resourceType: 'user', projectId: null });
    expect(entries[0]?.summary).toMatch(RECOVERY_SUMMARY);
    // The undelivered successor is gone; the new chain keeps rotating.
    expect(await db.refreshToken.findUnique({ where: { id: tokenIdOf(lost) } })).toBeNull();
    await refresh(resent.refreshToken).expect(200);
  }, TIMEOUT);

  it('lost response: parallel retries of the same stale token all answer 200 and keep the session', async () => {
    const { pair } = await newUserWithSession();
    const lost = data<TokenPair>(await refresh(pair.refreshToken, 'UA-1').expect(200));
    await ageExchange(pair, lost);

    const responses = await Promise.all([
      refresh(pair.refreshToken, 'UA-1'), refresh(pair.refreshToken, 'UA-1'), refresh(pair.refreshToken, 'UA-1'),
    ]);

    expect(responses.map((res) => res.status)).toEqual([200, 200, 200]);
    expect(await db.authSession.findUniqueOrThrow({ where: { id: sessionIdOf(pair) } }))
      .toMatchObject({ revokedAt: null });
    for (const res of responses) await refresh(data<TokenPair>(res).refreshToken).expect(200);
  }, TIMEOUT);

  it('lost response: a thief replaying the newest used token is caught when the real holder presents its successor', async () => {
    const { userId, pair } = await newUserWithSession();
    const holder = data<TokenPair>(await refresh(pair.refreshToken, 'UA-1').expect(200));
    await ageExchange(pair, holder);

    const thief = data<TokenPair>(await refresh(pair.refreshToken, 'UA-1').expect(200));
    await refresh(holder.refreshToken).expect(401);

    expect(await db.authSession.findUniqueOrThrow({ where: { id: sessionIdOf(pair) } }))
      .toMatchObject({ revokedReason: 'reuse' });
    // The thief's recovery and the holder's reuse revocation are both on the record.
    const summaries = (await db.auditEntry.findMany({
      where: { key: 'session.refresh', resourceId: userId },
      orderBy: { createdAt: 'asc' },
    })).map((entry) => entry.summary);
    expect(summaries).toHaveLength(2);
    expect(summaries[0]).toMatch(RECOVERY_SUMMARY);
    expect(summaries[1]).toBe('refresh token reuse; session revoked');
    await refresh(thief.refreshToken).expect(401);
    expect(await me(thief.accessToken)).toBe(401);
  }, TIMEOUT);

  // ── auth-passwords US-005: the recovery is bound to the token's first-use User-Agent ──────────────
  it('AC-4: a first-use refresh stores the presenting User-Agent hash and a non-null IP', async () => {
    const { pair } = await newUserWithSession();

    await refresh(pair.refreshToken, 'UA-1').expect(200);

    const presented = await db.refreshToken.findUniqueOrThrow({ where: { id: tokenIdOf(pair) } });
    expect(presented.usedAt).toBeInstanceOf(Date);
    expect(presented.usedUaHash).toBe(sha256('UA-1'));
    expect(presented.usedIp).toEqual(expect.any(String));
    expect(presented.usedIp).not.toBe('');
  }, TIMEOUT);

  // ── #470: the recorded address is the browser the proxy forwards, not the proxy's own ──────────────
  it('#470: a request through a trusted proxy records the forwarded client IP, not the socket peer', async () => {
    trustTheWebProxy();
    const { pair } = await newUserWithSession();

    // The harness listener is loopback and its peer is what `req.ip` would have written.
    await refresh(pair.refreshToken, 'UA-1', '203.0.113.7').expect(200);

    const presented = await db.refreshToken.findUniqueOrThrow({ where: { id: tokenIdOf(pair) } });
    expect(presented.usedIp).toBe('203.0.113.7');
  }, TIMEOUT);

  it('#470: a peer outside the trusted list cannot name the address it is recorded under', async () => {
    // The forwarded header is honoured only from a proxy the API trusts; loopback is outside this list.
    configureTrustProxy({ enabled: true, trustedProxies: ['10.0.0.0/8'] });
    const { pair } = await newUserWithSession();

    await refresh(pair.refreshToken, 'UA-1', '203.0.113.7').expect(200);

    const presented = await db.refreshToken.findUniqueOrThrow({ where: { id: tokenIdOf(pair) } });
    expect(presented.usedIp).toMatch(/^(::ffff:)?127\.0\.0\.1$/);
  }, TIMEOUT);

  it('#470: the lost-response recovery audit summary names the IP the retry presented', async () => {
    trustTheWebProxy();
    const { userId, pair } = await newUserWithSession();
    const lost = data<TokenPair>(await refresh(pair.refreshToken, 'UA-1', '203.0.113.7').expect(200));
    await ageExchange(pair, lost);

    await refresh(pair.refreshToken, 'UA-1', '198.51.100.9').expect(200);

    const entries = await db.auditEntry.findMany({ where: { key: 'session.refresh', resourceId: userId } });
    expect(entries).toHaveLength(1);
    expect(entries[0]?.summary)
      .toBe('refresh token lost-response recovery; session kept; ip 198.51.100.9');
  }, TIMEOUT);

  it('AC-5: a lost-response retry with the same User-Agent answers 200 and keeps the session', async () => {
    const { userId, pair } = await newUserWithSession();
    const lost = data<TokenPair>(await refresh(pair.refreshToken, 'UA-1').expect(200));
    await ageExchange(pair, lost);

    const resent = data<TokenPair>(await refresh(pair.refreshToken, 'UA-1').expect(200));

    expect(sessionIdOf(resent)).toBe(sessionIdOf(pair));
    expect(await db.authSession.findUniqueOrThrow({ where: { id: sessionIdOf(pair) } }))
      .toMatchObject({ revokedAt: null, revokedReason: null });
    // The binding is what let it through: the first use is still the one on record.
    expect((await db.refreshToken.findUniqueOrThrow({ where: { id: tokenIdOf(pair) } })).usedUaHash)
      .toBe(sha256('UA-1'));
    const entries = await db.auditEntry.findMany({ where: { key: 'session.refresh', resourceId: userId } });
    expect(entries).toHaveLength(1);
    expect(entries[0]?.summary).toMatch(RECOVERY_SUMMARY);
    expect(await me(resent.accessToken)).toBe(200);
  }, TIMEOUT);

  it('AC-6: a lost-response retry from a different User-Agent answers 401 and revokes as reuse', async () => {
    const { userId, pair } = await newUserWithSession();
    const lost = data<TokenPair>(await refresh(pair.refreshToken, 'UA-1').expect(200));
    await ageExchange(pair, lost);

    const retry = await refresh(pair.refreshToken, 'UA-2');

    expect(retry.status).toBe(401);
    expect(retry.body.ret).toBe(40000);
    expect(retry.body.message).toBe(AUTH_REFUSED);
    expect(await db.authSession.findUniqueOrThrow({ where: { id: sessionIdOf(pair) } }))
      .toMatchObject({ revokedReason: 'reuse' });
    // The mismatch is a reuse, so the entry is the unchanged reuse summary — one entry, not two.
    const entries = await db.auditEntry.findMany({ where: { key: 'session.refresh', resourceId: userId } });
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ summary: 'refresh token reuse; session revoked' });
  }, TIMEOUT);

  it('AC-15 (US-005): the User-Agent mismatch is the one reuse entry, with the unchanged summary', async () => {
    const { userId, pair } = await newUserWithSession();
    // A first use that bound the token to UA-1, whose successor the client never received.
    const lost = data<TokenPair>(await refresh(pair.refreshToken, 'UA-1').expect(200));
    await ageExchange(pair, lost);

    await refresh(pair.refreshToken, 'UA-2').expect(401);

    // Exactly one entry: a mismatch falls through to step 6, so no recovery entry is written beside it.
    const entries = await db.auditEntry.findMany({ where: { key: 'session.refresh', resourceId: userId } });
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      key: 'session.refresh',
      resourceType: 'user',
      resourceId: userId,
      projectId: null,
      summary: 'refresh token reuse; session revoked',
    });
  }, TIMEOUT);

  it('AC-8: a token whose first use stored no User-Agent (a legacy row) is never recovered', async () => {
    const { userId, pair } = await newUserWithSession();
    const lost = data<TokenPair>(await refresh(pair.refreshToken, 'UA-1').expect(200));
    await ageExchange(pair, lost);
    // What a row written before the migration looks like.
    await db.refreshToken.update({ where: { id: tokenIdOf(pair) }, data: { usedUaHash: null } });

    await refresh(pair.refreshToken, 'UA-1').expect(401);

    expect(await db.authSession.findUniqueOrThrow({ where: { id: sessionIdOf(pair) } }))
      .toMatchObject({ revokedReason: 'reuse' });
    expect(await db.auditEntry.count({ where: { key: 'session.refresh', resourceId: userId } })).toBe(1);
  }, TIMEOUT);

  it('AC-13: a refresh inside the grace window is not bound to the User-Agent', async () => {
    const { pair } = await newUserWithSession();
    // The first use records UA-1; a parallel retry from another client inside 30 s still rotates.
    await refresh(pair.refreshToken, 'UA-1').expect(200);

    const graceRetry = await refresh(pair.refreshToken, 'UA-2');

    expect(graceRetry.status).toBe(200);
    expect(await db.authSession.findUniqueOrThrow({ where: { id: sessionIdOf(pair) } }))
      .toMatchObject({ revokedAt: null });
    // Step 4 does not rewrite the binding: it belongs to the first use.
    expect((await db.refreshToken.findUniqueOrThrow({ where: { id: tokenIdOf(pair) } })).usedUaHash)
      .toBe(sha256('UA-1'));
  }, TIMEOUT);

  it('AC-14: the first use is not bound to the User-Agent the login presented', async () => {
    // `newUserWithSession` logs in with superagent's own User-Agent; the refresh below presents another.
    const { pair } = await newUserWithSession();

    expect((await refresh(pair.refreshToken, 'UA-1')).status).toBe(200);

    expect((await db.refreshToken.findUniqueOrThrow({ where: { id: tokenIdOf(pair) } })).usedUaHash)
      .toBe(sha256('UA-1'));
  }, TIMEOUT);

  it('lost response: a token used longer than the recovery window ago is reuse, even with nothing used after it', async () => {
    const { userId, pair } = await newUserWithSession();
    const lost = data<TokenPair>(await refresh(pair.refreshToken, 'UA-1').expect(200));
    await ageExchange(pair, lost, LOST_RESPONSE_WINDOW_MS + 1_000);

    await refresh(pair.refreshToken, 'UA-1').expect(401);

    expect(await db.authSession.findUniqueOrThrow({ where: { id: sessionIdOf(pair) } }))
      .toMatchObject({ revokedReason: 'reuse' });
    expect(await db.auditEntry.count({ where: { key: 'session.refresh', resourceId: userId } })).toBe(1);
  }, TIMEOUT);

  it('lost response: repeated replays do not slide the window (usedAt keeps the first use)', async () => {
    const { pair } = await newUserWithSession();
    const lost = data<TokenPair>(await refresh(pair.refreshToken, 'UA-1').expect(200));
    await ageExchange(pair, lost);
    const firstUse = (await db.refreshToken.findUniqueOrThrow({ where: { id: tokenIdOf(pair) } })).usedAt;

    await refresh(pair.refreshToken, 'UA-1').expect(200);

    expect((await db.refreshToken.findUniqueOrThrow({ where: { id: tokenIdOf(pair) } })).usedAt).toEqual(firstUse);
  }, TIMEOUT);

  it('a later token used at the identical instant still counts as moving past the replayed one', async () => {
    const { pair } = await newUserWithSession();
    const second = data<TokenPair>(await refresh(pair.refreshToken).expect(200));
    await refresh(second.refreshToken).expect(200);
    const at = new Date(Date.now() - 31_000);
    await db.refreshToken.updateMany({ where: { id: { in: [tokenIdOf(pair), tokenIdOf(second)] } }, data: { usedAt: at } });

    await refresh(pair.refreshToken).expect(401);

    expect(await db.authSession.findUniqueOrThrow({ where: { id: sessionIdOf(pair) } }))
      .toMatchObject({ revokedReason: 'reuse' });
  }, TIMEOUT);

  // Branch fix B1: the 60 s activity fill and the reuse eviction share one per-session lock, so a lookup
  // that read the session while it was still live cannot write that answer into the cache after the reuse
  // revocation evicted it — which would keep the revoked access token working for the rest of the TTL.
  it('AC-7 (paused lookup): a fill paused across the reuse revocation cannot re-cache the live answer', async () => {
    const { pair } = await newUserWithSession();
    const rotated = data<TokenPair>(await refresh(pair.refreshToken).expect(200));
    // The client used the successor, so the later replay of the first token is reuse, not a lost response.
    await refresh(rotated.refreshToken).expect(200);
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
