import { canRunDbTests } from '../../helpers/test-environment';
/**
 * Permissions P1l US-004 — member adds and invites take role keys only (AC-1 .. AC-8).
 *
 * The legacy `role` field is gone from both request DTOs, so the global ValidationPipe (whitelist, no
 * `forbidNonWhitelisted`) strips it: a member add without `roleKey` grants `viewer`, an invite without
 * `roleKey` answers 400 `invites.roleRequired`, and only `roleKey` decides the granted role.
 *
 * One booted application for the whole file, over real HTTP + Postgres: the first registration is the
 * installation's Owner and the Project Admin is bound through the members route, so every 201/400 below
 * is decided by the real pipe, the real guards and the real `RoleAdminService`.
 *
 * Run: cd apps/api && bun run test:db:up && bun run test:scoped test/integration/permissions/member-invite-role-keys-only.integration.spec.ts
 */
import { readFileSync } from 'fs';
import { join } from 'path';
import request from 'supertest';
import { NathApplication } from '@nathapp/nestjs-app';
import { PrismaService } from '@nathapp/nestjs-prisma';
import { PrismaClient } from '../../../src/generated/prisma/client';
import { resetDb } from '../../helpers/reset-db';
import { bootHttpApp, data, loginToken, resetThrottle, TEST_PASSWORD } from '../../helpers/http-app';

// The nax sandbox withholds host Postgres/Docker.
const describeIntegration = canRunDbTests() ? describe : describe.skip;

const OWNER_EMAIL = 'owner@koda.test';
/** Boot runs the system-role seeder, so the first hook needs a generous budget. */
const BOOT_TIMEOUT_MS = 30_000;
const TIMEOUT = 30_000;

/** The `GlobalExceptionsFilter` envelope codes these routes answer with. */
const CODE = { validation: -2 } as const;

const readTranslations = (file: string): Record<string, unknown> =>
  JSON.parse(readFileSync(join(__dirname, '../../../src/i18n/en', file), 'utf8')) as Record<string, unknown>;

const INVITES = readTranslations('invites.json');

/** The sentence at `<module>.<path>.<code>`, as the exception filter renders it. */
function inviteSentence(path: string, code: number): string {
  const key = `invites.${path}.${code}`;
  const node = key
    .split('.')
    .reduce<unknown>(
      (current, segment) => (typeof current === 'object' && current !== null ? (current as Record<string, unknown>)[segment] : undefined),
      { invites: INVITES },
    );
  if (typeof node !== 'string') throw new Error(`${key} is not declared in src/i18n/en/invites.json`);
  return node;
}

interface CreateInviteBody {
  outcome: 'INVITED' | 'ADDED';
  invite?: { id: string; email: string; role: string | null; roleKey: string | null; roleName: string | null };
}

describeIntegration('member adds and invites take role keys only (US-004)', () => {
  let app: NathApplication;
  let server: ReturnType<NathApplication['getHttpServer']>;
  let db: PrismaClient;
  let projectId: string;

  const tokens: Record<string, string> = {};
  const ids: Record<string, string> = {};
  const auth = (who: string) => ({ Authorization: `Bearer ${tokens[who]}` });
  const addMemberAs = (who: string) => request(server).post('/api/projects/team/members').set(auth(who));
  const inviteAs = (who: string) => request(server).post('/api/projects/team/invites').set(auth(who));

  /** Every role key the user is bound to in `team` — the "exactly one binding" assertions read the DB. */
  const roleKeysInTeam = async (userId: string): Promise<string[]> => {
    const bindings = await db.roleBinding.findMany({
      where: { principalType: 'USER', principalId: userId, projectId },
      include: { role: { select: { key: true } } },
    });
    return bindings.map((binding) => binding.role.key);
  };

  /** Creates a plain MEMBER account through the admin route and logs it in. */
  const createUser = async (who: string): Promise<string> => {
    const created = await request(server)
      .post('/api/admin/users')
      .set(auth('owner'))
      .send({ email: `${who}@koda.test`, name: who, password: TEST_PASSWORD })
      .expect(201);
    ids[who] = data<{ id: string }>(created).id;
    tokens[who] = await loginToken(server, `${who}@koda.test`);
    return ids[who] as string;
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

    const project = await request(server)
      .post('/api/projects')
      .set(auth('owner'))
      .send({ name: 'Team', slug: 'team', key: 'TEAM' })
      .expect(201);
    projectId = data<{ id: string }>(project).id;

    await createUser('padmin');
    for (const target of ['ac1-target', 'ac3-target']) await createUser(target);

    // The caller of every case below: a Project Admin of team, granted through a role key.
    await addMemberAs('owner').send({ email: 'padmin@koda.test', roleKey: 'project-admin' }).expect(201);
    expect(await roleKeysInTeam(ids.padmin as string)).toEqual(['project-admin']);
  }, BOOT_TIMEOUT_MS);

  beforeEach(() => {
    resetThrottle(app);
  });

  afterAll(async () => {
    await app.close();
  });

  it('AC-1 and AC-2: an add with only the legacy role answers 201 and grants exactly one viewer binding', async () => {
    const res = await addMemberAs('padmin').send({ email: 'ac1-target@koda.test', role: 'ADMIN' });

    expect(res.status).toBe(201);
    expect(data<{ userId: string }>(res).userId).toBe(ids['ac1-target']);
    expect(await roleKeysInTeam(ids['ac1-target'] as string)).toEqual(['viewer']);
  }, TIMEOUT);

  it('AC-3: roleKey developer beside the legacy role VIEWER leaves exactly one developer binding', async () => {
    const res = await addMemberAs('padmin').send({
      email: 'ac3-target@koda.test',
      roleKey: 'developer',
      role: 'VIEWER',
    });

    expect(res.status).toBe(201);
    expect(await roleKeysInTeam(ids['ac3-target'] as string)).toEqual(['developer']);
  }, TIMEOUT);

  it('AC-4: an explicit null roleKey is a 400 validation error and grants nothing', async () => {
    const res = await addMemberAs('padmin').send({ email: 'ac1-target@koda.test', roleKey: null });

    expect(res.status).toBe(400);
    expect(res.body.ret).toBe(CODE.validation);
    // The refusal names the offending field, so the client knows what to fix.
    expect(JSON.stringify(res.body)).toContain('roleKey');
    // Still the single viewer binding AC-2 wrote: the null-key request added nothing.
    expect(await roleKeysInTeam(ids['ac1-target'] as string)).toEqual(['viewer']);
  }, TIMEOUT);

  it('AC-5 and AC-6: an invite with only the legacy role answers 400 invites.roleRequired and stores no invite', async () => {
    const res = await inviteAs('padmin').send({ email: 'ac5@koda.test', role: 'DEVELOPER' });

    expect(res.status).toBe(400);
    expect(res.body.ret).toBe(CODE.validation);
    expect(res.body.message).toBe(inviteSentence('roleRequired', CODE.validation));
    expect(await db.projectInvite.findMany({ where: { projectId, email: 'ac5@koda.test' } })).toEqual([]);
  }, TIMEOUT);

  it('AC-7 and AC-8: roleKey developer beside the legacy role ADMIN answers 201 INVITED with roleKey developer', async () => {
    const res = await inviteAs('padmin').send({
      email: 'ac7@koda.test',
      roleKey: 'developer',
      role: 'ADMIN',
    });

    expect(res.status).toBe(201);
    const body = data<CreateInviteBody>(res);
    expect(body.outcome).toBe('INVITED');
    expect(body.invite?.roleKey).toBe('developer');

    const [stored] = await db.projectInvite.findMany({ where: { projectId, email: 'ac7@koda.test' } });
    const developer = await db.role.findUniqueOrThrow({ where: { key: 'developer' } });
    expect(stored?.roleId).toBe(developer.id);
  }, TIMEOUT);
});
