/**
 * Permissions P1 web US-003 — the project roles route and the unified members list, over real HTTP
 * and Postgres.
 *
 * One booted application for the whole file. The first registration is the installation`s Owner, so
 * the fixtures (users, projects, role bindings, one legacy `ProjectMember` row and three agents) are
 * built as that Owner. Every assertion acts as a principal whose only sources are the fixtures this
 * file writes: a role binding in the project, one legacy row, or a custom `project.read`-only role.
 *
 * Run: cd apps/api && bun run test:db:up && bun run test:scoped test/integration/projects/project-members-principals.integration.spec.ts
 */
import request from 'supertest';
import { NathApplication } from '@nathapp/nestjs-app';
import { PrismaService } from '@nathapp/nestjs-prisma';
import { PrismaClient } from '../../../src/generated/prisma/client';
import { RoleAdminService } from '../../../src/permissions/role-admin.service';
import type { RoleDomain } from '../../../src/permissions/permissions.types';
import { grantRole } from '../../../src/permissions/test-helpers/permission-fixtures';
import { resetDb } from '../../helpers/reset-db';
import { bootHttpApp, data, loginToken, resetThrottle, TEST_PASSWORD } from '../../helpers/http-app';

const describeIntegration = process.env.KODA_DB_TESTS === '1' ? describe : describe.skip;

const TIMEOUT = 30_000;
const BOOT_TIMEOUT = 120_000;

/** `p1` is the project every AC but AC-10 lists; `pn` is AC-10`s two-users-one-agent project. */
const PROJECT = { slug: 'p1', key: 'PONE' };
const THIN_PROJECT = { slug: 'pn', key: 'PNINE' };

/** The five fields a project role carries, and no other. */
const PROJECT_ROLE_FIELDS = ['description', 'id', 'key', 'name', 'system'];

interface MemberBinding {
  id: string | null;
  roleKey: string;
  roleName: string;
}

interface MemberRecord {
  userId: string | null;
  email: string | null;
  name: string | null;
  role: string;
  disabled: boolean;
  joinedAt: string;
  principalType: 'USER' | 'AGENT';
  principalId: string;
  agentSlug: string | null;
  bindings: MemberBinding[];
}

interface MemberPage {
  total: number;
  current: number;
  size: number;
  hasNext: boolean;
  hasPrev: boolean;
  records: MemberRecord[];
  canManage: boolean;
  viewerRole: string | null;
}

interface ProjectRole {
  id: string;
  key: string;
  name: string;
  description: string;
  system: boolean;
}

interface CreatedAgent {
  id: string;
  slug: string;
}

describeIntegration('project roles and the unified members list (US-003)', () => {
  let app: NathApplication;
  let server: ReturnType<NathApplication['getHttpServer']>;
  let db: PrismaClient;

  const tokens: Record<string, string> = {};
  const userIds: Record<string, string> = {};
  let p1Id = '';
  let thinId = '';
  const agents: Record<string, CreatedAgent> = {};
  const bindingIds: Record<string, string[]> = {};

  const auth = (who: string) => ({ Authorization: `Bearer ${tokens[who]}` });
  const rolesUrl = (slug: string) => `/api/projects/${slug}/roles`;
  const membersUrl = (slug: string) => `/api/projects/${slug}/members`;

  const createUser = async (who: string): Promise<void> => {
    const created = await request(server)
      .post('/api/admin/users')
      .set(auth('root'))
      .send({ email: `${who}@koda.test`, name: who, password: TEST_PASSWORD, role: 'MEMBER' })
      .expect(201);
    userIds[who] = data<{ id: string }>(created).id;
    resetThrottle(app);
    tokens[who] = await loginToken(server, `${who}@koda.test`);
  };

  const createProject = async (project: { slug: string; key: string }): Promise<string> => {
    const created = await request(server)
      .post('/api/projects')
      .set(auth('root'))
      .send({ name: project.slug.toUpperCase(), slug: project.slug, key: project.key })
      .expect(201);
    return data<{ id: string }>(created).id;
  };

  const createAgent = async (name: string, slug: string): Promise<CreatedAgent> => {
    const created = await request(server)
      .post('/api/agents')
      .set(auth('root'))
      .send({ name, slug })
      .expect(201);
    return data<{ agent: CreatedAgent }>(created).agent;
  };

  /** A binding of `who`/`agent` to `roleKey` in `projectId` (`null` = the all-projects binding). */
  const bind = async (
    principal: { type: 'USER' | 'AGENT'; id: string },
    roleKey: string,
    projectId: string | null,
  ): Promise<string> => (await grantRole(db, principal, roleKey, projectId)).id;

  /** Pins a binding's `createdAt`, so an ordering case states the order it asserts. */
  const setBindingCreatedAt = async (id: string, createdAt: Date): Promise<void> => {
    await db.roleBinding.update({ where: { id }, data: { createdAt } });
  };

  const roles = (slug: string, who: string) => request(server).get(rolesUrl(slug)).set(auth(who));

  const members = (slug: string, who: string, query = '') =>
    request(server).get(`${membersUrl(slug)}${query}`).set(auth(who));

  const page = async (slug: string, who: string, query = ''): Promise<MemberPage> =>
    data<MemberPage>(await members(slug, who, query).expect(200));

  beforeAll(async () => {
    await resetDb();
    app = await bootHttpApp({ registrationEnabled: false, ownerEmail: null });
    server = app.getHttpServer();
    db = app.get<PrismaService<PrismaClient>>(PrismaService).client as PrismaClient;

    const root = await request(server)
      .post('/api/auth/register')
      .send({ email: 'root@koda.test', name: 'Root', password: TEST_PASSWORD })
      .expect(201);
    tokens.root = data<{ accessToken: string }>(root).accessToken;

    // `viewer` lists; `dev` holds two project bindings; `legacydev` only a legacy row; `limited` holds a
    // custom role granting `project.read` and nothing else; `outsider` belongs to no project at all.
    for (const who of ['viewer', 'dev', 'legacydev', 'limited', 'outsider', 'thinone', 'thintwo']) {
      await createUser(who);
    }

    p1Id = await createProject(PROJECT);
    thinId = await createProject(THIN_PROJECT);

    await bind({ type: 'USER', id: userIds.viewer }, 'viewer', p1Id);
    // AC-5: the triager binding is written FIRST and carries the LATER date, so a list ordered by
    // insertion answers the other way round from one ordered by `createdAt`.
    const triagerBinding = await bind({ type: 'USER', id: userIds.dev }, 'triager', p1Id);
    const developerBinding = await bind({ type: 'USER', id: userIds.dev }, 'developer', p1Id);
    await setBindingCreatedAt(triagerBinding, new Date('2026-01-02T00:00:00.000Z'));
    await setBindingCreatedAt(developerBinding, new Date('2026-01-01T00:00:00.000Z'));
    // The order the route must answer the chips in: developer (older) then triager (newer).
    bindingIds.dev = [developerBinding, triagerBinding];
    // AC-8: the legacy row is `legacydev`'s only source in p1.
    await db.projectMember.create({
      data: { projectId: p1Id, userId: userIds.legacydev, role: 'DEVELOPER' },
    });
    // AC-11: a PROJECT role that grants project access (`project.read`) but not `member.read`.
    await db.role.create({
      data: {
        key: 'project-reader',
        name: 'Project Reader',
        description: 'Reads the project',
        scope: 'PROJECT',
        system: false,
        locked: false,
        permissions: ['project.read'],
      },
    });
    await bind({ type: 'USER', id: userIds.limited }, 'project-reader', p1Id);

    // Three agents: one bound in p1, one bound in every project (no source in p1), one bound in pn.
    agents.review = await createAgent('Review Agent', 'review-agent');
    agents.scout = await createAgent('Global Scout', 'global-scout');
    agents.thin = await createAgent('Thin Agent', 'thin-agent');
    bindingIds.review = [await bind({ type: 'AGENT', id: agents.review.id }, 'reviewer', p1Id)];
    await bind({ type: 'AGENT', id: agents.scout.id }, 'reviewer', null);
    await bind({ type: 'AGENT', id: agents.thin.id }, 'reviewer', thinId);

    // AC-10: exactly two users and one agent, bound in that order.
    await bind({ type: 'USER', id: userIds.thinone }, 'viewer', thinId);
    await bind({ type: 'USER', id: userIds.thintwo }, 'developer', thinId);
  }, BOOT_TIMEOUT);

  afterAll(async () => {
    await app?.close();
  });

  // -------------------------------------------------------------------------
  // AC-1 .. AC-3, AC-11 — GET /projects/:slug/roles
  // -------------------------------------------------------------------------

  it('AC-1: as a viewer of p, GET /api/projects/<p.slug>/roles answers 200 with every PROJECT role, system roles first then by key, each with exactly id, key, name, description and system, and no GLOBAL role', async () => {
    const res = await roles(PROJECT.slug, 'viewer').expect(200);

    const body = data<ProjectRole[]>(res);
    const projectRoles = await db.role.findMany({ where: { scope: 'PROJECT' }, select: { key: true } });
    const globalRoles = await db.role.findMany({ where: { scope: 'GLOBAL' }, select: { key: true } });

    expect(body.map((role) => role.key).sort()).toEqual(projectRoles.map((role) => role.key).sort());
    // No GLOBAL role (`owner`, `admin`, `member`, `agent`) is listable as a project role.
    expect(body.filter((role) => globalRoles.some(({ key }) => key === role.key))).toEqual([]);
    // Every entry is exactly the five fields the client renders a chip from.
    for (const role of body) expect(Object.keys(role).sort()).toEqual(PROJECT_ROLE_FIELDS);
    // System roles first, then by key: the seeded roles are all system, so the whole list is by key.
    const seeded = body.filter((role) => role.system).map((role) => role.key);
    expect(seeded).toEqual(['approver', 'developer', 'project-admin', 'reviewer', 'triager', 'verifier', 'viewer']);
    const custom = body.filter((role) => !role.system).map((role) => role.key);
    expect(custom).toEqual(['project-reader']);
    expect(body.slice(0, seeded.length).every((role) => role.system)).toBe(true);
  }, TIMEOUT);

  it('AC-1 (scan limit): 501 PROJECT roles are all answered — the route is not limited to one read page', async () => {
    // Neither role creation nor storage bounds the `Role` table, so a capped read decides how many roles a
    // project admin can see. 501 PROJECT roles is one more than a single 500-row read answers.
    const bulk = Array.from({ length: 501 }, (_, index) => ({
      key: `bulk-${String(index).padStart(3, '0')}`,
      name: `Bulk role ${index}`,
      description: '',
      scope: 'PROJECT',
      system: false,
      locked: false,
      permissions: [],
    }));

    try {
      await db.role.createMany({ data: bulk });

      const body = data<ProjectRole[]>(await roles(PROJECT.slug, 'viewer').expect(200));

      const stored = await db.role.findMany({ where: { scope: 'PROJECT' }, select: { key: true } });
      expect(body).toHaveLength(stored.length);
      expect(body.map((role) => role.key).sort()).toEqual(stored.map((role) => role.key).sort());
      // Ordering survives the paging: every system role first, then keys ascending within each group.
      const systemCount = body.filter((role) => role.system).length;
      expect(body.slice(0, systemCount).every((role) => role.system)).toBe(true);
      expect(body.slice(systemCount).some((role) => role.system)).toBe(false);
      const custom = body.slice(systemCount).map((role) => role.key);
      expect(custom).toEqual([...custom].sort());
      expect(custom).toContain('bulk-500');
    } finally {
      await db.role.deleteMany({ where: { key: { startsWith: 'bulk-' } } });
    }
  }, TIMEOUT);

  it('AC-2: with RoleAdminService.listProjectRoles spied to resolve one role, GET /api/projects/<p.slug>/roles as a viewer calls the spy once and returns that one role', async () => {
    const roleAdmin = app.get(RoleAdminService);
    const stored = await db.role.findUniqueOrThrow({ where: { key: 'developer' } });
    const onlyRole: RoleDomain = {
      id: stored.id,
      key: stored.key,
      name: stored.name,
      description: stored.description,
      scope: 'PROJECT',
      system: stored.system,
      locked: stored.locked,
      permissions: [],
    };
    const spy = vi.spyOn(roleAdmin, 'listProjectRoles').mockResolvedValue([onlyRole]);

    try {
      const res = await roles(PROJECT.slug, 'viewer').expect(200);

      expect(spy).toHaveBeenCalledTimes(1);
      expect(spy).toHaveBeenCalledWith();
      expect(data<ProjectRole[]>(res)).toEqual([{
        id: stored.id,
        key: 'developer',
        name: stored.name,
        description: stored.description,
        system: stored.system,
      }]);
    } finally {
      spy.mockRestore();
    }
  }, TIMEOUT);

  it('AC-3: as a user with no access to p, GET /api/projects/<p.slug>/roles answers 403', async () => {
    const res = await roles(PROJECT.slug, 'outsider');

    expect(res.status).toBe(403);
  }, TIMEOUT);

  it('AC-11: a caller with project access but without member.read is refused by GET /api/projects/<p.slug>/roles with 403', async () => {
    // `limited` holds `project.read` through the custom PROJECT role, so the members gate admits it and
    // only the route`s `member.read` can refuse it.
    expect(await permissionsOf('limited', PROJECT.slug)).toContain('project.read');

    const res = await roles(PROJECT.slug, 'limited');

    expect(res.status).toBe(403);
  }, TIMEOUT);

  /** The caller`s effective keys in a project, read through `GET /me/permissions`. */
  async function permissionsOf(who: string, slug: string): Promise<string[]> {
    const res = await request(server).get(`/api/me/permissions?project=${slug}`).set(auth(who)).expect(200);
    return data<{ keys: string[] }>(res).keys;
  }

  // -------------------------------------------------------------------------
  // AC-4 .. AC-10 — GET /projects/:slug/members
  // -------------------------------------------------------------------------

  it('AC-4: as a viewer of p, GET /api/projects/<p.slug>/members without principals returns only user rows, each with principalType USER, principalId equal to userId and agentSlug null', async () => {
    const body = await page(PROJECT.slug, 'viewer');

    expect(body.records.length).toBeGreaterThan(0);
    for (const record of body.records) {
      expect(record.principalType).toBe('USER');
      expect(record.agentSlug).toBeNull();
      expect(record.userId).not.toBeNull();
      expect(record.principalId).toBe(record.userId);
    }
    // The reviewer-bound agent is a member of p, and it is still not on this page.
    expect(body.records.some((record) => record.principalId === agents.review.id)).toBe(false);
  }, TIMEOUT);

  it("AC-5: GET /api/projects/<p.slug>/members returns a developer-and-triager holder's row with two bindings ordered by binding createdAt", async () => {
    const body = await page(PROJECT.slug, 'viewer');

    const row = body.records.find((record) => record.principalId === userIds.dev);
    expect(row).toBeDefined();
    expect(row?.bindings).toEqual([
      { id: bindingIds.dev?.[0], roleKey: 'developer', roleName: 'Developer' },
      { id: bindingIds.dev?.[1], roleKey: 'triager', roleName: 'Triager' },
    ]);
    // The chip order is the bindings' `createdAt` order (developer is the older one), not the order the
    // rows were written in (the triager first) and not their ids.
    const stored = await db.roleBinding.findMany({
      where: { principalType: 'USER', principalId: userIds.dev, projectId: p1Id },
      orderBy: { createdAt: 'asc' },
      select: { id: true, createdAt: true, role: { select: { key: true } } },
    });
    expect(stored.map(({ id, role }) => ({ id, roleKey: role.key }))).toEqual([
      { id: bindingIds.dev?.[0], roleKey: 'developer' },
      { id: bindingIds.dev?.[1], roleKey: 'triager' },
    ]);
    expect(stored[0]?.createdAt.getTime()).toBeLessThan(stored[1]?.createdAt.getTime() ?? 0);
  }, TIMEOUT);

  it("AC-6: with an agent holding a reviewer binding in p, principals=all returns the user rows followed by one agent row, and total counts both", async () => {
    const users = await page(PROJECT.slug, 'viewer');
    const all = await page(PROJECT.slug, 'viewer', '?principals=all');

    expect(all.total).toBe(users.total + 1);
    expect(all.records).toHaveLength(all.total);
    expect(all.records.slice(0, users.records.length).map((record) => record.principalId))
      .toEqual(users.records.map((record) => record.principalId));
    // Every row past the users is an agent: exactly one of them here.
    const agentRows = all.records.slice(users.records.length);
    expect(agentRows.map((record) => record.principalType)).toEqual(['AGENT']);
    const agentRow = agentRows[0] as MemberRecord;
    expect(agentRow).toMatchObject({
      principalId: agents.review.id,
      principalType: 'AGENT',
      userId: null,
      email: null,
      agentSlug: 'review-agent',
      name: 'Review Agent',
      disabled: false,
    });
    expect(agentRow.bindings).toEqual([
      { id: bindingIds.review?.[0], roleKey: 'reviewer', roleName: 'Reviewer' },
    ]);
  }, TIMEOUT);

  it('AC-7: an agent whose reviewer binding is a projectId-null one and has no source in p is not a row of principals=all', async () => {
    const all = await page(PROJECT.slug, 'viewer', '?principals=all');

    // Agent rows are on this page: the reviewer-bound agent of p is listed.
    expect(all.records.some((record) => record.principalId === agents.review.id)).toBe(true);
    // The all-projects binding is not a p membership, so the scout has no row.
    expect(all.records.some((record) => record.principalId === agents.scout.id)).toBe(false);
    // The binding exists: it applies everywhere, and it is still not a p membership.
    await expect(
      db.roleBinding.count({
        where: { principalType: 'AGENT', principalId: agents.scout.id, projectId: null, role: { key: 'reviewer' } },
      }),
    ).resolves.toBe(1);
  }, TIMEOUT);

  it('AC-8: a user whose only source in p is a legacy ProjectMember row of DEVELOPER is absent from the members listing', async () => {
    const body = await page(PROJECT.slug, 'viewer');

    const row = body.records.find((record) => record.principalId === userIds.legacydev);
    expect(row).toBeUndefined();
    expect(body.records.flatMap(record => record.bindings).every(binding => binding.id !== null)).toBe(true);
  }, TIMEOUT);

  it('AC-9: GET /api/projects/<p.slug>/members?principals=agents answers 400 validation', async () => {
    const res = await members(PROJECT.slug, 'viewer', '?principals=agents');

    expect(res.status).toBe(400);
  }, TIMEOUT);

  it('AC-10: with principals=all, size=1 and two users plus one agent in a project, current=3 returns the agent row and hasNext false', async () => {
    // `thinone` is one of pn's two user members, so it holds `member.read` there.
    const body = await page(THIN_PROJECT.slug, 'thinone', '?principals=all&size=1&current=3');

    expect(body.total).toBe(3);
    expect(body.hasNext).toBe(false);
    expect(body.records).toHaveLength(1);
    expect(body.records[0]).toMatchObject({
      principalId: agents.thin.id,
      principalType: 'AGENT',
      agentSlug: 'thin-agent',
    });
    // The first two pages are the two user rows, in the order the users listing reports.
    const users = await page(THIN_PROJECT.slug, 'thinone', '?size=100');
    expect(users.records.map((record) => record.principalId)).toEqual([userIds.thinone, userIds.thintwo]);
  }, TIMEOUT);

  it('AC-6 (scan limit): a full mixed page whose chips exceed one read keeps every binding', async () => {
    // The worst legitimate page: 50 users + 50 agents on one `size=100` page, each holding 51 project
    // bindings — 5 100 chips. No membership source is near its own cap, so a read capped at 5 000 rows
    // would silently truncate the page's chips (and the last agent would come back with none).
    const CHIP_ROLES = 51;
    const PRINCIPALS = 50;
    const chipRoleKeys = Array.from({ length: CHIP_ROLES }, (_, index) => `chip-${String(index).padStart(2, '0')}`);
    const chipProjectId = await createProject({ slug: 'pchips', key: 'PCHIP' });

    try {
      await db.role.createMany({
        data: chipRoleKeys.map((key) => ({
          key, name: key, description: '', scope: 'PROJECT', system: false, locked: false, permissions: [],
        })),
      });
      const chipRoles = await db.role.findMany({ where: { key: { in: chipRoleKeys } }, select: { id: true } });
      expect(chipRoles).toHaveLength(CHIP_ROLES);

      await db.user.createMany({
        data: Array.from({ length: PRINCIPALS }, (_, index) => ({
          email: `chip-user-${index}@koda.test`, name: `chip user ${index}`, passwordHash: 'not-a-real-hash', role: 'MEMBER',
        })),
      });
      await db.agent.createMany({
        data: Array.from({ length: PRINCIPALS }, (_, index) => ({
          name: `Chip Agent ${index}`, slug: `chip-agent-${index}`, apiKeyHash: `chip-agent-hash-${index}`,
        })),
      });
      const chipUsers = await db.user.findMany({
        where: { email: { startsWith: 'chip-user-' } }, select: { id: true },
      });
      const chipAgents = await db.agent.findMany({
        where: { slug: { startsWith: 'chip-agent-' } }, select: { id: true },
      });
      expect([chipUsers.length, chipAgents.length]).toEqual([PRINCIPALS, PRINCIPALS]);

      // Their baseline global bindings, as every principal created through the API gets.
      const [memberRole, agentRole] = await Promise.all([
        db.role.findUniqueOrThrow({ where: { key: 'member' }, select: { id: true } }),
        db.role.findUniqueOrThrow({ where: { key: 'agent' }, select: { id: true } }),
      ]);
      await db.roleBinding.createMany({
        data: [
          ...chipUsers.map((user) => ({ principalType: 'USER', principalId: user.id, roleId: memberRole.id, projectId: null, grantedByType: 'SYSTEM', grantedById: 'test' })),
          ...chipAgents.map((agent) => ({ principalType: 'AGENT', principalId: agent.id, roleId: agentRole.id, projectId: null, grantedByType: 'SYSTEM', grantedById: 'test' })),
        ],
      });

      // 100 principals × 51 project bindings = 5 100 rows, written in batches (a single statement would
      // approach the driver's parameter limit).
      const chipBindings = [
        ...chipUsers.flatMap((user) => chipRoles.map((role) => ({
          principalType: 'USER', principalId: user.id, roleId: role.id, projectId: chipProjectId,
          grantedByType: 'SYSTEM', grantedById: 'test',
        }))),
        ...chipAgents.flatMap((agent) => chipRoles.map((role) => ({
          principalType: 'AGENT', principalId: agent.id, roleId: role.id, projectId: chipProjectId,
          grantedByType: 'SYSTEM', grantedById: 'test',
        }))),
      ];
      for (let index = 0; index < chipBindings.length; index += 1000) {
        await db.roleBinding.createMany({ data: chipBindings.slice(index, index + 1000) });
      }
      await expect(
        db.roleBinding.count({ where: { projectId: chipProjectId } }),
      ).resolves.toBe(PRINCIPALS * 2 * CHIP_ROLES);

      const body = await page('pchips', 'root', '?principals=all&size=100');

      expect(body.total).toBe(PRINCIPALS * 2);
      expect(body.records).toHaveLength(PRINCIPALS * 2);
      expect(body.records.map((record) => record.principalType))
        .toEqual([...Array.from({ length: PRINCIPALS }, () => 'USER'), ...Array.from({ length: PRINCIPALS }, () => 'AGENT')]);
      // Every row keeps all 51 chips: no record is short, and the last agent is not the one that loses them.
      expect(body.records.map((record) => record.bindings.length)).toEqual(
        Array.from({ length: PRINCIPALS * 2 }, () => CHIP_ROLES),
      );
      expect(body.records.at(-1)?.bindings).toHaveLength(CHIP_ROLES);
      expect(body.records.flatMap((record) => record.bindings)).toHaveLength(PRINCIPALS * 2 * CHIP_ROLES);
      // The chips are the 51 roles themselves, not 51 copies of one.
      for (const record of body.records) {
        expect(record.bindings.map((binding) => binding.roleKey).sort()).toEqual([...chipRoleKeys].sort());
      }
    } finally {
      // Keep the shared fixture clean: the chip roles and their bindings are this case's own.
      await db.roleBinding.deleteMany({ where: { projectId: chipProjectId } });
      await db.role.deleteMany({ where: { key: { startsWith: 'chip-' } } });
    }
  }, 60_000);
});
