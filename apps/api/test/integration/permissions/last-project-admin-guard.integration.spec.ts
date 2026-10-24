import { canRunDbTests } from '../../helpers/test-environment';
/**
 * Permissions P1 US-001 — the last-Project-Admin guard on `DELETE /role-bindings/:id`, over real
 * HTTP + Postgres (AC-1 .. AC-8).
 *
 * Every case builds its own project and principals, so the file is order-independent and no case
 * reads a row an earlier one wrote. Access is granted through bindings only: each user gets its
 * baseline, and the custom co-admin holds a PROJECT role with every entry (`['*']`) in P — the
 * permission to manage bindings there, and nothing global.
 *
 * Run: cd apps/api && bun run test:db:up && bun run test:scoped test/integration/permissions/last-project-admin-guard.integration.spec.ts
 */
import { readFileSync } from 'fs';
import { join } from 'path';
import request from 'supertest';
import * as bcrypt from 'bcrypt';
import { NathApplication } from '@nathapp/nestjs-app';
import { PrismaService } from '@nathapp/nestjs-prisma';
import { PrismaClient } from '../../../src/generated/prisma/client';
import { MembershipService } from '../../../src/permissions/membership.service';
import { grantBaseline, grantRole } from '../../../src/permissions/test-helpers/permission-fixtures';
import { resetDb } from '../../helpers/reset-db';
import { bootHttpApp, loginToken, resetThrottle, TEST_PASSWORD } from '../../helpers/http-app';

// The nax sandbox withholds host Postgres/Docker.
const describeIntegration = canRunDbTests() ? describe : describe.skip;

/** Booting `AppModule` runs the system-role seeder, so the first hook needs a generous budget. */
const BOOT_TIMEOUT_MS = 60_000;
/** The custom PROJECT role the co-admin of a project holds: every entry, no global authority. */
const CO_ADMIN_ROLE_KEY = 'custom-co-admin';
/** `members.lastAdmin.409` as the i18n loader reads it: the exact sentence of the refusal. */
const LAST_ADMIN = (
  JSON.parse(readFileSync(join(__dirname, '../../../src/i18n/en/members.json'), 'utf8')) as Record<
    string,
    Record<string, string>
  >
)['lastAdmin']?.['409'] as string;

describeIntegration('the last Project Admin guard on binding removal (US-001)', () => {
  let app: NathApplication;
  let server: ReturnType<NathApplication['getHttpServer']>;
  let db: PrismaClient;
  let membership: MembershipService;
  let passwordHash: string;
  let sequence = 0;
  const tokens = new Map<string, string>();

  const newProject = async (): Promise<{ id: string }> => {
    const n = (sequence += 1);
    return db.project.create({ data: { name: `Guard ${n}`, slug: `guard-${n}`, key: `G${n}` } });
  };

  /** A user with its baseline binding; `disabled` is the account state the guard reads. */
  const newUser = async (disabled = false) => {
    const n = (sequence += 1);
    const user = await db.user.create({
      data: { email: `guard-${n}@koda.test`, name: `Guard ${n}`, passwordHash, disabled },
    });
    await grantBaseline(db, { type: 'USER', id: user.id });
    return user;
  };

  /** The user's access token, minted once per user and after every grant it holds. */
  const tokenFor = async (user: { id: string; email: string }): Promise<string> => {
    const cached = tokens.get(user.id);
    if (cached) return cached;
    resetThrottle(app);
    const token = await loginToken(server, user.email);
    tokens.set(user.id, token);
    return token;
  };

  const grant = async (userId: string, roleKey: string, projectId: string | null): Promise<{ id: string }> => {
    const binding = await grantRole(db, { type: 'USER', id: userId }, roleKey, projectId);
    // The grant is written under the permission cache, so the cache is dropped explicitly.
    await membership.invalidatePermissions();
    return binding;
  };

  const projectAdminIn = (projectId: string, userId: string) => grant(userId, 'project-admin', projectId);

  /** A user holding the custom PROJECT role of every entry in the project, and no global authority. */
  const coAdminIn = async (projectId: string): Promise<{ token: string; id: string }> => {
    const user = await newUser();
    await grant(user.id, CO_ADMIN_ROLE_KEY, projectId);
    return { token: await tokenFor(user), id: user.id };
  };

  /** A user holding the global `admin` binding: every project key, plus `role.binding.global`. */
  const globalAdmin = async (): Promise<{ token: string; id: string }> => {
    const user = await newUser();
    await grant(user.id, 'admin', null);
    return { token: await tokenFor(user), id: user.id };
  };

  const deleteBinding = (token: string, id: string) =>
    request(server).delete(`/api/role-bindings/${id}`).set({ Authorization: `Bearer ${token}` });

  const projectAdminCount = (projectId: string) =>
    db.roleBinding.count({ where: { projectId, role: { key: 'project-admin' } } });

  const expectRefusal = (res: request.Response): void => {
    expect(res.status).toBe(409);
    expect(res.body.ret).toBe(409);
    expect(res.body.message).toBe(LAST_ADMIN);
  };

  beforeAll(async () => {
    await resetDb();
    passwordHash = await bcrypt.hash(TEST_PASSWORD, 4);
    app = await bootHttpApp({ registrationEnabled: false, ownerEmail: null });
    server = app.getHttpServer();
    db = app.get<PrismaService<PrismaClient>>(PrismaService).client as PrismaClient;
    membership = app.get(MembershipService);
    // The seeder ran on bootstrap, so the system roles below are the ones every grant resolves.
    await db.role.create({
      data: {
        key: CO_ADMIN_ROLE_KEY,
        name: 'Custom co-admin',
        description: '',
        scope: 'PROJECT',
        system: false,
        locked: false,
        permissions: ['*'],
      },
    });
  }, BOOT_TIMEOUT_MS);

  beforeEach(() => {
    resetThrottle(app);
  });

  afterAll(async () => {
    await app.close();
  });

  it('AC-1: the custom co-admin\'s DELETE of the only Project Admin\'s binding answers 409 members.lastAdmin', async () => {
    const project = await newProject();
    const target = await newUser();
    const binding = await projectAdminIn(project.id, target.id);
    const coAdmin = await coAdminIn(project.id);

    const res = await deleteBinding(coAdmin.token, binding.id);

    expectRefusal(res);
  });

  it('AC-2: after that refused DELETE the binding is still there', async () => {
    const project = await newProject();
    const target = await newUser();
    const binding = await projectAdminIn(project.id, target.id);
    const coAdmin = await coAdminIn(project.id);

    await deleteBinding(coAdmin.token, binding.id).expect(409);

    expect(await db.roleBinding.findUnique({ where: { id: binding.id } })).not.toBeNull();
    expect(await projectAdminCount(project.id)).toBe(1);
  });

  it('AC-3: a global admin\'s DELETE of that same binding answers 204', async () => {
    const project = await newProject();
    const target = await newUser();
    const binding = await projectAdminIn(project.id, target.id);
    // The same data as AC-1: one enabled Project Admin, whose binding a global admin may remove.
    await coAdminIn(project.id);
    const admin = await globalAdmin();

    await deleteBinding(admin.token, binding.id).expect(204);

    expect(await db.roleBinding.findUnique({ where: { id: binding.id } })).toBeNull();
    expect(await projectAdminCount(project.id)).toBe(0);
  });

  it('AC-4: with two enabled Project Admins the co-admin deletes one with 204', async () => {
    const project = await newProject();
    const first = await newUser();
    const second = await newUser();
    const firstBinding = await projectAdminIn(project.id, first.id);
    await projectAdminIn(project.id, second.id);
    const coAdmin = await coAdminIn(project.id);

    await deleteBinding(coAdmin.token, firstBinding.id).expect(204);

    expect(await db.roleBinding.findUnique({ where: { id: firstBinding.id } })).toBeNull();
    expect(await projectAdminCount(project.id)).toBe(1);
  });

  it('AC-5: a disabled second Project Admin does not count, so the enabled one is refused', async () => {
    const project = await newProject();
    const enabled = await newUser();
    const disabled = await newUser(true);
    const binding = await projectAdminIn(project.id, enabled.id);
    await projectAdminIn(project.id, disabled.id);
    const coAdmin = await coAdminIn(project.id);

    const res = await deleteBinding(coAdmin.token, binding.id);

    expectRefusal(res);
    expect(await db.roleBinding.findUnique({ where: { id: binding.id } })).not.toBeNull();
  });

  it('AC-6: the only Project Admin being disabled, the co-admin deletes its binding with 204', async () => {
    const project = await newProject();
    const disabled = await newUser(true);
    const binding = await projectAdminIn(project.id, disabled.id);
    const coAdmin = await coAdminIn(project.id);

    await deleteBinding(coAdmin.token, binding.id).expect(204);

    expect(await db.roleBinding.findUnique({ where: { id: binding.id } })).toBeNull();
  });

  it('AC-7: another project\'s Project Admin does not count for this project', async () => {
    const project = await newProject();
    const other = await newProject();
    const target = await newUser();
    const binding = await projectAdminIn(project.id, target.id);
    // P2's own enabled Project Admin: a count that spans projects would let this removal through.
    await projectAdminIn(other.id, (await newUser()).id);
    const coAdmin = await coAdminIn(project.id);

    const res = await deleteBinding(coAdmin.token, binding.id);

    expectRefusal(res);
    expect(await db.roleBinding.findUnique({ where: { id: binding.id } })).not.toBeNull();
  });

  it('AC-8: two concurrent removals of the two Project Admin bindings leave one, one 204 and one 409', async () => {
    const project = await newProject();
    const first = await projectAdminIn(project.id, (await newUser()).id);
    const second = await projectAdminIn(project.id, (await newUser()).id);
    const [coAdminA, coAdminB] = [await coAdminIn(project.id), await coAdminIn(project.id)];
    expect(await projectAdminCount(project.id)).toBe(2);

    const results = await Promise.all([
      deleteBinding(coAdminA.token, first.id),
      deleteBinding(coAdminB.token, second.id),
    ]);

    expect(results.map((res) => res.status).sort()).toEqual([204, 409]);
    const refusal = results.find((res) => res.status === 409) as request.Response;
    expectRefusal(refusal);
    expect(await projectAdminCount(project.id)).toBe(1);
  });
});
