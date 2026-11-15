import { Test, TestingModule } from '@nestjs/testing';
import { AppFactory, NathApplication } from '@nathapp/nestjs-app';
import { FastifyAdapter } from '@nestjs/platform-fastify';
import { randomUUID } from 'crypto';
import { AppModule } from '../../../src/app.module';
import { PasswordResetStoreModule } from '../../../src/auth/password-reset/password-reset-store.module';
import { PasswordResetTokenStore } from '../../../src/auth/password-reset/password-reset-token.store';
import { PrismaClient } from '../../../src/generated/prisma/client';
import { canRunDbTests } from '../../helpers/test-environment';
import { resetDb } from '../../helpers/reset-db';
import { fixtureDb, asTestActor } from '../../helpers/action-context';

const describeDb = canRunDbTests() ? describe : describe.skip;
describeDb('password reset store on PostgreSQL', () => {
  let nest: TestingModule; let app: NathApplication; let db: PrismaClient; let store: PasswordResetTokenStore;
  let userId: string; let otherId: string;
  const expiry = new Date('2030-01-01T00:00:00Z');
  beforeAll(async () => {
    await resetDb();
    nest = await Test.createTestingModule({ imports: [AppModule, PasswordResetStoreModule] }).compile();
    app = AppFactory.useApp(nest.createNestApplication(new FastifyAdapter()));
    await app.init(); db = fixtureDb(app);
    store = asTestActor(app.get(PasswordResetTokenStore), { type: 'SYSTEM', id: 'seed' });
  });
  afterAll(async () => { await app?.close(); });
  beforeEach(async () => {
    userId = (await db.user.create({ data: { email: `${randomUUID()}@k.t`, passwordHash: 'x' } })).id;
    otherId = (await db.user.create({ data: { email: `${randomUUID()}@k.t`, passwordHash: 'x' } })).id;
  });
  it('AC-1: replaces unused rows with the specified hash and expiry', async () => {
    await db.passwordResetToken.create({ data: { userId, tokenHash: randomUUID(), expiresAt: expiry } });
    const hash = randomUUID();
    await store.replaceUnused(userId, hash, expiry);
    const rows = await db.passwordResetToken.findMany({ where: { userId, usedAt: null } });
    expect(rows).toHaveLength(1); expect(rows[0].tokenHash).toBe(hash); expect(rows[0].expiresAt).toEqual(expiry);
  });
  it('AC-2: retains used rows', async () => {
    const row = await db.passwordResetToken.create({ data: { userId, tokenHash: randomUUID(), expiresAt: expiry, usedAt: new Date() } });
    await store.replaceUnused(userId, randomUUID(), expiry);
    expect(await db.passwordResetToken.findUnique({ where: { id: row.id } })).not.toBeNull();
  });
  it('AC-3: retains another user’s unused row', async () => {
    const row = await db.passwordResetToken.create({ data: { userId: otherId, tokenHash: randomUUID(), expiresAt: expiry } });
    await store.replaceUnused(userId, randomUUID(), expiry);
    expect(await db.passwordResetToken.findUnique({ where: { id: row.id } })).not.toBeNull();
  });
  it('AC-4: finds a hash with user disabled status or null', async () => {
    await db.user.update({ where: { id: userId }, data: { disabled: true } });
    const row = await db.passwordResetToken.create({ data: { userId, tokenHash: randomUUID(), expiresAt: expiry } });
    expect(await store.findByHash(row.tokenHash)).toEqual({ id: row.id, userId, expiresAt: expiry, usedAt: null, userDisabled: true });
    expect(await store.findByHash(randomUUID())).toBeNull();
  });
  it('AC-5: marks a token used once', async () => {
    const row = await db.passwordResetToken.create({ data: { userId, tokenHash: randomUUID(), expiresAt: expiry } });
    expect(await store.markUsed(row.id, new Date())).toBe(1);
    expect(await store.markUsed(row.id, new Date())).toBe(0);
  });
  it('serializes concurrent replacements even with no initial row', async () => {
    await Promise.all([store.replaceUnused(userId, randomUUID(), expiry), store.replaceUnused(userId, randomUUID(), expiry)]);
    expect(await db.passwordResetToken.count({ where: { userId, usedAt: null } })).toBe(1);
  });
});
