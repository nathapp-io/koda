import { canRunDbTests } from '../../helpers/test-environment';
import request from 'supertest';
import * as bcrypt from 'bcrypt';
import { NathApplication } from '@nathapp/nestjs-app';
import { PrismaClient } from '../../../src/generated/prisma/client';
import { PermissionService } from '../../../src/permissions/permission.service';
import { MembershipService } from '../../../src/permissions/membership.service';
import { grantBaseline, grantRole } from '../../../src/permissions/test-helpers/permission-fixtures';
import { resetDb } from '../../helpers/reset-db';
import { bootHttpApp, data, loginToken, resetThrottle, TEST_PASSWORD } from '../../helpers/http-app';
import { expectGuardActive, fixtureDb } from '../../helpers/action-context';

// The nax sandbox withholds host Postgres/Docker.
const describeIntegration = canRunDbTests() ? describe : describe.skip;

describeIntegration('project.read assignees (PG + HTTP)', () => {
  let app: NathApplication;
  let db: PrismaClient;
  let permissions: PermissionService;
  let membership: MembershipService;
  let passwordHash: string;
  let sequence = 0;
  const newUser = async () => {
    const n = ++sequence;
    const user = await db.user.create({ data: { email: `assignee-${n}@koda.test`, name: `U${n}`, passwordHash } });
    await grantBaseline(db, { type: 'USER', id: user.id });
    return user;
  };
  const newAgent = async () => {
    const n = ++sequence;
    const agent = await db.agent.create({ data: { name: `A${n}`, slug: `assignee-${n}`, apiKeyHash: `assignee-${n}` } });
    await grantBaseline(db, { type: 'AGENT', id: agent.id });
    return agent;
  };
  const newProject = () => {
    const n = ++sequence;
    return db.project.create({ data: { name: `P${n}`, slug: `assignee-${n}`, key: `A${n}` } });
  };
  const customRole = (scope: 'GLOBAL' | 'PROJECT', entries: string[]) => db.role.create({
    data: { key: `assignee-role-${++sequence}`, name: 'Custom', scope, permissions: entries },
  });
  beforeAll(async () => {
    await resetDb();
    passwordHash = await bcrypt.hash(TEST_PASSWORD, 4);
    app = await bootHttpApp({ registrationEnabled: false, ownerEmail: null });
    db = fixtureDb(app);
    permissions = app.get(PermissionService);
    membership = app.get(MembershipService);
  }, 60_000);
  afterAll(async () => { await app?.close(); });
  beforeEach(async () => {
    await db.roleBinding.deleteMany({});
    await db.user.deleteMany({});
    await db.agent.deleteMany({});
    await membership.invalidatePermissions();
    resetThrottle(app);
  });

  it('writes need an action context', async () => {
    await expect(expectGuardActive(app)).resolves.toBeUndefined();
  });

  it('P1m AC-6: HTTP offers developer-bound users before ACTIVE developer-bound agents', async () => {
    const u = await newUser(); const a = await newAgent(); const p = await newProject();
    await grantRole(db, { type: 'USER', id: u.id }, 'developer', p.id);
    await grantRole(db, { type: 'AGENT', id: a.id }, 'developer', p.id);
    await membership.invalidatePermissions();
    const token = await loginToken(app.getHttpServer(), u.email);
    const res = await request(app.getHttpServer()).get(`/api/projects/${p.slug}/assignees`).query({ q: '' }).auth(token, { type: 'bearer' }).expect(200);
    expect(data<{ items: { id: string; type: string }[] }>(res).items.map(({ id, type }) => ({ id, type }))).toEqual([
      { id: u.id, type: 'user' }, { id: a.id, type: 'agent' },
    ]);
  });

  it.each([[1, 'developer'], [2, 'admin']] as const)('AC-%i: includes a %s-bound user', async (_ac, key) => {
    const u = await newUser();
    const p = await newProject();
    await grantRole(db, { type: 'USER', id: u.id }, key, key === 'admin' ? null : p.id);
    expect(await permissions.principalIdsWithKey('USER', p.id, 'project.read')).toEqual([u.id]);
  });
  it('AC-3: includes a custom GLOBAL project.read holder', async () => {
    const u = await newUser();
    const p = await newProject();
    const role = await customRole('GLOBAL', ['project.read']);
    await grantRole(db, { type: 'USER', id: u.id }, role.key);
    expect(await permissions.principalIdsWithKey('USER', p.id, 'project.read')).toEqual([u.id]);
  });
  it('AC-4: omits a custom PROJECT role without project.read', async () => {
    const u = await newUser();
    const p = await newProject();
    const role = await customRole('PROJECT', ['ticket.create']);
    await grantRole(db, { type: 'USER', id: u.id }, role.key, p.id);
    expect(await permissions.principalIdsWithKey('USER', p.id, 'project.read')).toEqual([]);
  });
  it('AC-5: omits a baseline-only user', async () => {
    const u = await newUser();
    const p = await newProject();
    expect(await permissions.principalIdsWithKey('USER', p.id, 'project.read')).toEqual([]);
  });
  it('AC-6: an invalid GLOBAL entry does not discard the valid developer', async () => {
    const developer = await newUser();
    const invalid = await newUser();
    const p = await newProject();
    const role = await customRole('GLOBAL', ['not.a.key']);
    await grantRole(db, { type: 'USER', id: invalid.id }, role.key);
    await grantRole(db, { type: 'USER', id: developer.id }, 'developer', p.id);
    expect(await permissions.principalIdsWithKey('USER', p.id, 'project.read')).toEqual([developer.id]);
  });
  it('AC-7: includes a viewer-bound agent', async () => {
    const a = await newAgent();
    const p = await newProject();
    await grantRole(db, { type: 'AGENT', id: a.id }, 'viewer', p.id);
    expect(await permissions.principalIdsWithKey('AGENT', p.id, 'project.read')).toEqual([a.id]);
  });
  it('AC-8: omits a baseline-only agent', async () => {
    const a = await newAgent();
    const p = await newProject();
    expect(await permissions.principalIdsWithKey('AGENT', p.id, 'project.read')).toEqual([]);
  });
  it('AC-9: sorts and deduplicates local and all-project holders', async () => {
    const users = [await newUser(), await newUser()].sort((a, b) => a.id.localeCompare(b.id));
    const [a, b] = users;
    const p = await newProject();
    await grantRole(db, { type: 'USER', id: a.id }, 'viewer', p.id);
    await grantRole(db, { type: 'USER', id: b.id }, 'developer', p.id);
    await grantRole(db, { type: 'USER', id: b.id }, 'viewer');
    expect(await permissions.principalIdsWithKey('USER', p.id, 'project.read')).toEqual([a.id, b.id]);
  });
  it('AC-11: omits a developer bound only in P2', async () => {
    const u = await newUser();
    const p = await newProject();
    const p2 = await newProject();
    await grantRole(db, { type: 'USER', id: u.id }, 'developer', p2.id);
    expect(await permissions.principalIdsWithKey('USER', p.id, 'project.read')).toEqual([]);
  });
  it('AC-12: USER enumeration omits an agent', async () => {
    const a = await newAgent();
    const p = await newProject();
    await grantRole(db, { type: 'AGENT', id: a.id }, 'viewer', p.id);
    expect(await permissions.principalIdsWithKey('USER', p.id, 'project.read')).toEqual([]);
  });

  it.each([13, 14, 18])('AC-%i: HTTP consumes key holders, omitting baseline-only principals', async (ac) => {
    const caller = await newUser();
    const p = await newProject();
    await grantRole(db, { type: 'USER', id: caller.id }, 'developer', p.id);
    const target = await newUser();
    const agent = await newAgent();
    if (ac === 13) {
      const role = await customRole('GLOBAL', ['project.read']);
      await grantRole(db, { type: 'USER', id: target.id }, role.key);
      await grantRole(db, { type: 'AGENT', id: agent.id }, role.key);
    } else if (ac === 14) {
      const role = await customRole('PROJECT', ['ticket.create']);
      await grantRole(db, { type: 'USER', id: target.id }, role.key, p.id);
    }
    await membership.invalidatePermissions();
    const token = await loginToken(app.getHttpServer(), caller.email);
    const enumerate = vi.spyOn(permissions, 'principalIdsWithKey');
    let res: request.Response;
    try {
      res = await request(app.getHttpServer()).get(`/api/projects/${p.slug}/assignees`).query({ q: '' }).auth(token, { type: 'bearer' }).expect(200);
      expect(enumerate).toHaveBeenCalledWith('USER', p.id, 'project.read');
      expect(enumerate).toHaveBeenCalledWith('AGENT', p.id, 'project.read');
    } finally {
      enumerate.mockRestore();
    }
    const items = data<{ items: { id: string }[] }>(res).items.map(({ id }) => id);
    expect(items).toContain(caller.id);
    if (ac === 13) {
      expect(items).toContain(target.id);
      expect(items).toContain(agent.id);
    } else {
      expect(items).not.toContain(target.id);
      expect(items).not.toContain(agent.id);
    }
  });
});
