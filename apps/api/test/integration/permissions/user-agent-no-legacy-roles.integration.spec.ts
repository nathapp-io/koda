/**
 * Permissions P1l US-005 — user and agent creation carry no legacy roles (AC-1 .. AC-10).
 *
 * The legacy role fields are gone from `CreateUserDto`, `UpdateUserDto` and `CreateAgentDto`, so the
 * global ValidationPipe (whitelist, no `forbidNonWhitelisted`) strips them: a user is created as a
 * plain member with only the `member` baseline binding, a user patch changes nothing but `disabled`,
 * and an agent is created without any `AgentRoleEntry` row.
 *
 * One booted application for the whole file, over real HTTP + Postgres. The first registration is the
 * installation's Owner; every "global admin" below is created through `POST /admin/users` and then
 * given the global `admin` binding through `POST /role-bindings` (roleKey `admin`, `projectId` null).
 * Binding first and logging in after matters: the binding route can bump the target's `tokenVersion`,
 * which would invalidate a token minted before it. Each case uses its own principals so that a token
 * a previous case revoked can never be the reason a later case answers 401.
 *
 * Run: cd apps/api && bun run test:db:up && bun run test:scoped test/integration/permissions/user-agent-no-legacy-roles.integration.spec.ts
 */
import { readFileSync } from 'fs';
import { join } from 'path';
import request from 'supertest';
import { NathApplication } from '@nathapp/nestjs-app';
import { PrismaService } from '@nathapp/nestjs-prisma';
import { PrismaClient } from '../../../src/generated/prisma/client';
import { resetDb } from '../../helpers/reset-db';
import { bootHttpApp, data, loginToken, resetThrottle, TEST_PASSWORD } from '../../helpers/http-app';

const describeIntegration = process.env.KODA_DB_TESTS === '1' ? describe : describe.skip;

const OWNER_EMAIL = 'owner@koda.test';
/** Boot runs the system-role seeder, so the first hook needs a generous budget. */
const BOOT_TIMEOUT_MS = 60_000;
const TIMEOUT = 30_000;

/** US-007 removed `UserAdminDto.role` with the rest of the legacy response fields. */
interface CreatedUser {
  id: string;
  email: string;
}

/** `users.self.40003`, the sentence the self-disable refusal carries. */
const USERS_SELF_REFUSED = (
  JSON.parse(readFileSync(join(__dirname, '../../../src/i18n/en/users.json'), 'utf8')) as {
    self: Record<string, string>;
  }
).self['40003'] as string;

/** The accounts the fixtures build: every one is a plain member unless `globalAdmin` says otherwise. */
const ACCOUNTS = {
  /** Caller of AC-1, AC-3/4 and AC-8. */
  gadmin: true,
  /** Caller of AC-5: a second global admin, so the target is never the caller. */
  gadmin2: true,
  /** AC-5's target: holds the global admin binding the patch must leave alone. */
  ac5Target: true,
  /** AC-6/AC-7's caller, patching its own row. */
  selfAdmin: true,
  /** AC-3/AC-4's target: a plain member, so the legacy `role: ADMIN` patch must grant it nothing. */
  plain: false,
} as const;

describeIntegration('user and agent creation carry no legacy roles (US-005)', () => {
  let app: NathApplication;
  let server: ReturnType<NathApplication['getHttpServer']>;
  let db: PrismaClient;

  const tokens: Record<string, string> = {};
  const ids: Record<string, string> = {};
  const auth = (who: string) => ({ Authorization: `Bearer ${tokens[who]}` });
  const adminUsers = (who: string) => request(server).post('/api/admin/users').set(auth(who));
  const patchUser = (who: string, id: string) => request(server).patch(`/api/admin/users/${id}`).set(auth(who));

  /** The role keys of every projectId-null binding the user holds — the "baseline only" assertion. */
  const globalRoleKeys = async (userId: string): Promise<string[]> => {
    const bindings = await db.roleBinding.findMany({
      where: { principalType: 'USER', principalId: userId, projectId: null },
      include: { role: { select: { key: true } } },
    });
    return bindings.map((binding) => binding.role.key).sort();
  };

  beforeAll(async () => {
    await resetDb();
    app = await bootHttpApp({ registrationEnabled: true, ownerEmail: null });
    server = app.getHttpServer();
    db = app.get<PrismaService<PrismaClient>>(PrismaService).client as PrismaClient;

    const registered = await request(server)
      .post('/api/auth/register')
      .send({ email: OWNER_EMAIL, name: 'Owner', password: TEST_PASSWORD })
      .expect(201);
    tokens.owner = data<{ accessToken: string }>(registered).accessToken;
    resetThrottle(app);

    for (const [who, globalAdmin] of Object.entries(ACCOUNTS)) {
      // The create itself is AC-1/AC-2's subject for the AC-1 account; here it just builds the actor.
      const created = await adminUsers('owner')
        .send({ email: `${who}@koda.test`, name: who, password: TEST_PASSWORD })
        .expect(201);
      ids[who] = data<CreatedUser>(created).id;
      if (!globalAdmin) continue;

      await request(server)
        .post('/api/role-bindings')
        .set(auth('owner'))
        .send({ principalType: 'USER', principalId: ids[who], roleKey: 'admin', projectId: null })
        .expect(201);
      // Mint the token only after the binding: the write can revoke an older one.
      tokens[who] = await loginToken(server, `${who}@koda.test`);
      resetThrottle(app);
    }
  }, BOOT_TIMEOUT_MS);

  beforeEach(() => {
    resetThrottle(app);
  });

  afterAll(async () => {
    await app.close();
  });

  // -------------------------------------------------------------------------
  // AC-1 .. AC-2 — a create with the legacy role is a plain member
  // -------------------------------------------------------------------------

  it('AC-1 and AC-2: a create with { role: ADMIN } answers 201 and grants only the member baseline', async () => {
    const res = await adminUsers('gadmin').send({
      email: 'ac1@koda.test',
      name: 'AC1',
      password: TEST_PASSWORD,
      role: 'ADMIN',
    });

    expect(res.status).toBe(201);
    const created = data<CreatedUser>(res);
    expect(created.email).toBe('ac1@koda.test');
    // US-007: the response carries no legacy role any more — the stripped field changed nothing in the
    // DTO. What the whitelist kept is what the row holds: the least-privileged role.
    expect(created).not.toHaveProperty('role');
    const stored = await db.user.findUniqueOrThrow({ where: { id: created.id }, select: { role: true } });
    expect(stored.role).toBe('MEMBER');
    expect(await globalRoleKeys(created.id)).toEqual(['member']);
  }, TIMEOUT);

  // -------------------------------------------------------------------------
  // AC-3 .. AC-5 — a patch with the legacy role changes no binding
  // -------------------------------------------------------------------------

  it('AC-3 and AC-4: a patch with { role: ADMIN } answers 200 and grants no admin or owner binding', async () => {
    await expect(globalRoleKeys(ids.plain as string)).resolves.toEqual(['member']);

    const res = await patchUser('gadmin', ids.plain as string).send({ role: 'ADMIN' });

    expect(res.status).toBe(200);
    expect(await globalRoleKeys(ids.plain as string)).toEqual(['member']);
    await expect(
      db.roleBinding.count({
        where: {
          principalType: 'USER',
          principalId: ids.plain as string,
          role: { key: { in: ['admin', 'owner'] } },
        },
      }),
    ).resolves.toBe(0);
  }, TIMEOUT);

  it("AC-5: a patch with { role: MEMBER } leaves the target's global admin binding in place", async () => {
    const [adminBinding] = await db.roleBinding.findMany({
      where: { principalType: 'USER', principalId: ids.ac5Target as string, projectId: null, role: { key: 'admin' } },
      select: { id: true },
    });
    expect(adminBinding).toBeDefined();

    const res = await patchUser('gadmin2', ids.ac5Target as string).send({ role: 'MEMBER' });

    expect(res.status).toBe(200);
    expect(await globalRoleKeys(ids.ac5Target as string)).toEqual(['admin', 'member']);
    await expect(db.roleBinding.count({ where: { id: adminBinding?.id as string } })).resolves.toBe(1);
  }, TIMEOUT);

  // -------------------------------------------------------------------------
  // AC-6 .. AC-7 — the self rule refuses only a self-disable
  // -------------------------------------------------------------------------

  it('AC-6: a self-disable answers 403 users.self and leaves the user enabled', async () => {
    const res = await patchUser('selfAdmin', ids.selfAdmin as string).send({ disabled: true });

    expect(res.status).toBe(403);
    expect(res.body.ret).toBe(40003);
    expect(res.body.message).toBe(USERS_SELF_REFUSED);
    await expect(
      db.user.findUniqueOrThrow({ where: { id: ids.selfAdmin as string }, select: { disabled: true } }),
    ).resolves.toEqual({ disabled: false });
  }, TIMEOUT);

  it('AC-7: a self-patch with the legacy role answers 200', async () => {
    const res = await patchUser('selfAdmin', ids.selfAdmin as string).send({ role: 'MEMBER' });

    expect(res.status).toBe(200);
    await expect(globalRoleKeys(ids.selfAdmin as string)).resolves.toEqual(['admin', 'member']);
  }, TIMEOUT);

  // -------------------------------------------------------------------------
  // AC-8 .. AC-10 — an agent create carries capabilities only
  // -------------------------------------------------------------------------

  it('AC-8, AC-9 and AC-10: an agent create with roles writes no role row and exactly the named capability', async () => {
    const res = await request(server).post('/api/agents').set(auth('gadmin')).send({
      name: 'Legacy Roles Agent',
      slug: 'legacy-roles-agent',
      roles: ['DEVELOPER'],
      capabilities: ['nax'],
    });

    expect(res.status).toBe(201);
    const body = data<{ agent: { id: string; slug: string }; apiKey: string }>(res);
    expect(body.agent.slug).toBe('legacy-roles-agent');

    await expect(db.agentRoleEntry.count({ where: { agentId: body.agent.id } })).resolves.toBe(0);
    const capabilities = await db.agentCapabilityEntry.findMany({
      where: { agentId: body.agent.id },
      select: { capability: true },
    });
    expect(capabilities.map(({ capability }) => capability)).toEqual(['nax']);
  }, TIMEOUT);
});
