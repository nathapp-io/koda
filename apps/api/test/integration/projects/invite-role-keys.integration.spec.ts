/**
 * Permissions P1 web US-005 — invites carry a role key (AC-1 .. AC-12).
 *
 * One booted application for the whole file, over real HTTP + Postgres: the first registration is the
 * installation's Owner, every other actor is created through `POST /admin/users`, and the custom PROJECT
 * roles are created and bound through the roles API — so every 201/403/404/409 below is decided by real
 * bindings and the real `RoleAdminService`.
 *
 * Run: cd apps/api && bun run test:db:up && bun run test:scoped test/integration/projects/invite-role-keys.integration.spec.ts
 */
import { readFileSync } from 'fs';
import { join } from 'path';
import request from 'supertest';
import { NathApplication } from '@nathapp/nestjs-app';
import { PrismaService } from '@nathapp/nestjs-prisma';
import { PrismaClient } from '../../../src/generated/prisma/client';
import { hashInviteToken } from '../../../src/projects/invites/invite-token';
import { PrismaProjectInvitesRepository } from '../../../src/projects/invites/prisma-project-invites.repository';
import { resetDb } from '../../helpers/reset-db';
import { bootHttpApp, data, loginToken, resetThrottle, TEST_PASSWORD } from '../../helpers/http-app';

const describeIntegration = process.env.KODA_DB_TESTS === '1' ? describe : describe.skip;

const OWNER_EMAIL = 'owner@koda.test';
const BOOT_TIMEOUT_MS = 30_000;
const TIMEOUT = 30_000;

/** The `GlobalExceptionsFilter` envelope codes these routes answer with. */
const CODE = { validation: -2, forbidden: 40003, notFound: 404, conflict: 409 } as const;

const readTranslations = (file: string): Record<string, unknown> =>
  JSON.parse(readFileSync(join(__dirname, '../../../src/i18n/en', file), 'utf8')) as Record<string, unknown>;

const TRANSLATIONS = { invites: readTranslations('invites.json'), permissions: readTranslations('permissions.json') };

/** The sentence at `<module>.<path>.<code>`, as the exception filter renders it. */
function sentence(module: 'invites' | 'permissions', path: string, code: number): string {
  const key = `${module}.${path}.${code}`;
  const node = key
    .split('.')
    .reduce<unknown>(
      (current, segment) => (typeof current === 'object' && current !== null ? (current as Record<string, unknown>)[segment] : undefined),
      TRANSLATIONS,
    );
  if (typeof node !== 'string') throw new Error(`${key} is not declared in src/i18n/en/${module}.json`);
  return node;
}

interface InviteBody {
  id: string;
  email: string;
  roleKey: string | null;
  roleName: string | null;
}

interface CreateBody {
  outcome: 'INVITED' | 'ADDED';
  invite?: InviteBody;
  invitePath?: string;
  member?: { bindings: Array<{ id: string | null; roleKey: string; roleName: string }> };
}

interface RoleBody {
  id: string;
  key: string;
  name: string;
}

const tokenFrom = (invitePath: string | undefined): string => (invitePath ?? '').split('/').pop() ?? '';

describeIntegration('invite role keys (US-005)', () => {
  let app: NathApplication;
  let server: ReturnType<NathApplication['getHttpServer']>;
  let db: PrismaClient;
  let projectId: string;

  const tokens: Record<string, string> = {};
  const ids: Record<string, string> = {};
  const base = '/api/projects/team/invites';
  const auth = (who: string) => ({ Authorization: `Bearer ${tokens[who]}` });
  const invite = (who: string) => request(server).post(base).set(auth(who));

  const bindingsInTeam = (userId: string) =>
    db.roleBinding.findMany({
      where: { principalType: 'USER', principalId: userId, projectId },
      include: { role: { select: { key: true } } },
    });
  const invitesFor = (email: string) => db.projectInvite.findMany({ where: { projectId, email } });

  const createUser = async (who: string): Promise<string> => {
    const created = await request(server)
      .post('/api/admin/users')
      .set(auth('owner'))
      .send({ email: `${who}@koda.test`, name: who, password: TEST_PASSWORD, role: 'MEMBER' })
      .expect(201);
    ids[who] = data<{ id: string }>(created).id;
    tokens[who] = await loginToken(server, `${who}@koda.test`);
    return ids[who] as string;
  };

  const createRole = async (key: string, permissions: string[]): Promise<RoleBody> => {
    const res = await request(server)
      .post('/api/roles')
      .set(auth('owner'))
      .send({ key, name: `Role ${key}`, scope: 'PROJECT', permissions })
      .expect(201);
    return data<RoleBody>(res);
  };

  /** Accepting needs a password that satisfies the complexity rule. */
  const accept = (token: string) =>
    request(server).post(`/api/invites/${token}/accept`).send({ name: 'Newcomer', password: TEST_PASSWORD });

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

    const customId = await createUser('custom');
    await createUser('padmin');
    await createUser('verifier-target');

    await createRole('inviter', ['invite.create', 'invite.read', 'project.read']);
    await request(server)
      .post('/api/role-bindings')
      .set(auth('owner'))
      .send({ principalType: 'USER', principalId: customId, roleKey: 'inviter', projectId })
      .expect(201);

    await request(server)
      .post('/api/projects/team/members')
      .set(auth('owner'))
      .send({ email: 'padmin@koda.test', roleKey: 'project-admin' })
      .expect(201);
  }, BOOT_TIMEOUT_MS);

  beforeEach(() => {
    resetThrottle(app);
  });

  afterAll(async () => {
    await app.close();
  });

  it('AC-1: a Project Admin invites a new address with roleKey triager; roleId is stored, the DTO names the role and carries no legacy role', async () => {
    const res = await invite('padmin').send({ email: 'ac1@koda.test', roleKey: 'triager' });

    expect(res.status).toBe(201);
    const body = data<CreateBody>(res);
    expect(body.outcome).toBe('INVITED');
    const triager = await db.role.findUniqueOrThrow({ where: { key: 'triager' } });
    const [stored] = await invitesFor('ac1@koda.test');
    expect(stored?.roleId).toBe(triager.id);
    expect(body.invite?.roleKey).toBe('triager');
    expect(body.invite?.roleName).toBe(triager.name);
    // US-007 removed `InviteDto.role`: the key and the name are how the client words the role.
    expect(body.invite).not.toHaveProperty('role');
  }, TIMEOUT);

  it('AC-2: a caller holding a custom role without the developer keys is refused 403 permissions.escalation and no invite is created', async () => {
    const res = await invite('custom').send({ email: 'ac2@koda.test', roleKey: 'developer' });

    expect(res.status).toBe(403);
    expect(res.body.ret).toBe(CODE.forbidden);
    expect(res.body.message).toBe(sentence('permissions', 'escalation', CODE.forbidden));
    expect(await invitesFor('ac2@koda.test')).toEqual([]);
  }, TIMEOUT);

  it('AC-3: no roleKey is 400 invites.roleRequired; a legacy role beside the key is stripped and the key decides', async () => {
    const neither = await invite('padmin').send({ email: 'ac3@koda.test' });
    expect(neither.status).toBe(400);
    expect(neither.body.ret).toBe(CODE.validation);
    expect(neither.body.message).toBe(sentence('invites', 'roleRequired', CODE.validation));

    // US-004 (P1l): the legacy `role` field is gone — the pipe strips it, so a create carrying only that
    // field is the same as a create with neither, and one carrying both grants the key's role.
    const legacyOnly = await invite('padmin').send({ email: 'ac3legacy@koda.test', role: 'VIEWER' });
    expect(legacyOnly.status).toBe(400);
    expect(legacyOnly.body.message).toBe(sentence('invites', 'roleRequired', CODE.validation));

    const both = await invite('padmin').send({ email: 'ac3@koda.test', role: 'ADMIN', roleKey: 'viewer' });
    expect(both.status).toBe(201);
    expect(data<CreateBody>(both).invite?.roleKey).toBe('viewer');
    expect((await invitesFor('ac3@koda.test')).map((row) => row.roleId)).toEqual([(await db.role.findUniqueOrThrow({ where: { key: 'viewer' } })).id]);
    expect(await invitesFor('ac3legacy@koda.test')).toEqual([]);
  }, TIMEOUT);

  it('AC-3: an explicit null roleKey is a 400 validation error, and an explicit null role is only stripped', async () => {
    for (const body of [
      { email: 'ac3null@koda.test', roleKey: null },
      { email: 'ac3null@koda.test', role: null, roleKey: null },
    ]) {
      const res = await invite('padmin').send(body);
      expect(res.status).toBe(400);
      expect(res.body.ret).toBe(CODE.validation);
    }
    // A null legacy role is not a declared property any more, so it neither validates nor counts as a key.
    const nullRole = await invite('padmin').send({ email: 'ac3null@koda.test', role: null });
    expect(nullRole.status).toBe(400);
    expect(nullRole.body.message).toBe(sentence('invites', 'roleRequired', CODE.validation));
    expect(await invitesFor('ac3null@koda.test')).toEqual([]);
  }, TIMEOUT);

  it('AC-4 and AC-10: an existing user is ADDED with a verifier binding, returned as the only chip', async () => {
    const res = await invite('padmin').send({ email: 'verifier-target@koda.test', roleKey: 'verifier' });

    expect(res.status).toBe(201);
    const body = data<CreateBody>(res);
    expect(body.outcome).toBe('ADDED');
    const stored = await bindingsInTeam(ids['verifier-target'] as string);
    expect(stored).toHaveLength(1);
    expect(stored[0]?.role.key).toBe('verifier');
    expect(body.member?.bindings).toEqual([
      { id: stored[0]?.id, roleKey: 'verifier', roleName: expect.any(String) },
    ]);
  }, TIMEOUT);

  it('AC-5: accepting an invite created with roleKey triager creates the user with a triager binding', async () => {
    const created = data<CreateBody>(await invite('padmin').send({ email: 'ac5@koda.test', roleKey: 'triager' }).expect(201));

    const res = await accept(tokenFrom(created.invitePath));

    expect(res.status).toBe(201);
    const user = await db.user.findFirstOrThrow({ where: { email: 'ac5@koda.test' } });
    const bindings = await bindingsInTeam(user.id);
    expect(bindings.map((binding) => binding.role.key)).toEqual(['triager']);
  }, TIMEOUT);

  it('P1m AC-7/8/9: a null roleId lists no role and refuses acceptance without creating an account or binding', async () => {
    const bindingsBefore = await db.roleBinding.count();
    const row = await db.projectInvite.create({ data: {
      projectId, email: 'ac6@koda.test', roleId: null,
      tokenHash: hashInviteToken('ac6-raw-token'), expiresAt: new Date(Date.now() + 86_400_000),
    } });
    const listed = await request(server).get(base).set(auth('owner')).expect(200);
    expect(data<InviteBody[]>(listed).find(invite => invite.id === row.id)).toMatchObject({ roleKey: null, roleName: null });
    const res = await accept('ac6-raw-token');
    expect(res.status).toBe(409);
    expect(res.body.message).toBe(sentence('invites', 'roleGone', CODE.conflict));
    expect(await db.user.count({ where: { email: 'ac6@koda.test' } })).toBe(0);
    expect(await db.roleBinding.count()).toBe(bindingsBefore);
  }, TIMEOUT);

  it('AC-7: accepting an invite with null roleId is 409 invites.roleGone and leaves no user and no binding', async () => {
    const bindingsBefore = await db.roleBinding.count();
    await db.projectInvite.create({
      data: {
        projectId,
        email: 'ac7@koda.test',
        roleId: null,
        tokenHash: hashInviteToken('ac7-raw-token'),
        expiresAt: new Date(Date.now() + 86_400_000),
      },
    });

    const res = await accept('ac7-raw-token');

    expect(res.status).toBe(409);
    expect(res.body.ret).toBe(CODE.conflict);
    expect(res.body.message).toBe(sentence('invites', 'roleGone', CODE.conflict));
    expect(await db.user.count({ where: { email: 'ac7@koda.test' } })).toBe(0);
    expect(await db.roleBinding.count()).toBe(bindingsBefore);
  }, TIMEOUT);

  it('AC-7: a role deleted and its key reused mid-accept is 409 invites.roleGone, never the replacement role', async () => {
    // The invite is issued for a custom role; the acceptance then reads that invite, and a concurrent
    // admin deletes the role and creates a broader one under the same key before the claim. Binding the
    // *key* would have granted the replacement role's permissions; the persisted roleId is what binds.
    const original = await createRole('swap', ['project.read']);
    const created = data<CreateBody>(await invite('owner').send({ email: 'ac7swap@koda.test', roleKey: 'swap' }).expect(201));
    const bindingsBefore = await db.roleBinding.count();

    const repo = app.get(PrismaProjectInvitesRepository);
    const read = repo.findByTokenHash.bind(repo);
    const spy = vi.spyOn(repo, 'findByTokenHash').mockImplementation(async (tokenHash: string) => {
      // The invite as it was issued, captured before the deletion below commits.
      const snapshot = await read(tokenHash);
      await request(server).delete(`/api/roles/${original.id}`).set(auth('owner')).expect(204);
      const replacement = await createRole('swap', ['project.read', 'ticket.read']);
      expect(replacement.id).not.toBe(original.id);
      return snapshot;
    });

    let res: request.Response;
    try {
      res = await accept(tokenFrom(created.invitePath));
    } finally {
      spy.mockRestore();
    }

    expect(res.status).toBe(409);
    expect(res.body.ret).toBe(CODE.conflict);
    expect(res.body.message).toBe(sentence('invites', 'roleGone', CODE.conflict));
    // Nothing was created: the account and the claimed invite rolled back with the refused binding.
    expect(await db.user.count({ where: { email: 'ac7swap@koda.test' } })).toBe(0);
    expect(await db.roleBinding.count()).toBe(bindingsBefore);
    expect(await db.roleBinding.count({ where: { role: { key: 'swap' } } })).toBe(0);
    const stored = await db.projectInvite.findFirstOrThrow({ where: { projectId, email: 'ac7swap@koda.test' } });
    expect(stored.status).toBe('PENDING');
    expect(stored.roleId).toBeNull();
  }, TIMEOUT);

  it('AC-8: deleting the custom role named by an unaccepted invite is 204 and nulls the invite roleId', async () => {
    const role = await createRole('temporary', ['project.read']);
    await invite('owner').send({ email: 'ac8@koda.test', roleKey: 'temporary' }).expect(201);
    const [before] = await invitesFor('ac8@koda.test');
    expect(before?.roleId).toBe(role.id);

    await request(server).delete(`/api/roles/${role.id}`).set(auth('owner')).expect(204);

    const [after] = await invitesFor('ac8@koda.test');
    expect(after?.roleId).toBeNull();
  }, TIMEOUT);

  it('AC-9: the preview answers exactly seven fields with roleKey triager', async () => {
    const created = data<CreateBody>(await invite('padmin').send({ email: 'ac9@koda.test', roleKey: 'triager' }).expect(201));

    const res = await request(server).get(`/api/invites/${tokenFrom(created.invitePath)}`);

    expect(res.status).toBe(200);
    const body = data<Record<string, unknown>>(res);
    // US-007: `InvitePreviewDto.role` is gone, which leaves the seven fields the doc names.
    expect(Object.keys(body).sort()).toEqual(
      ['email', 'expiresAt', 'inviterName', 'projectName', 'projectSlug', 'roleKey', 'roleName'].sort(),
    );
    expect(body.roleKey).toBe('triager');
    expect(body).not.toHaveProperty('role');
  }, TIMEOUT);

  it('AC-11: inviting the caller own email is 403 permissions.selfBinding and leaves the bindings unchanged', async () => {
    const before = await bindingsInTeam(ids.padmin as string);

    const res = await invite('padmin').send({ email: 'padmin@koda.test', roleKey: 'viewer' });

    expect(res.status).toBe(403);
    expect(res.body.ret).toBe(CODE.forbidden);
    expect(res.body.message).toBe(sentence('permissions', 'selfBinding', CODE.forbidden));
    expect((await bindingsInTeam(ids.padmin as string)).map((binding) => binding.id).sort()).toEqual(
      before.map((binding) => binding.id).sort(),
    );
  }, TIMEOUT);

  it('AC-12: an unknown role key is 404 permissions.roleNotFound and creates no invite', async () => {
    const res = await invite('padmin').send({ email: 'ac12@koda.test', roleKey: 'no-such-role' });

    expect(res.status).toBe(404);
    expect(res.body.ret).toBe(CODE.notFound);
    expect(res.body.message).toBe(sentence('permissions', 'roleNotFound', CODE.notFound));
    expect(await invitesFor('ac12@koda.test')).toEqual([]);
  }, TIMEOUT);
});
