import request from 'supertest';
import * as bcrypt from 'bcrypt';
import { readFileSync } from 'fs';
import { join } from 'path';
import { NathApplication } from '@nathapp/nestjs-app';
import { PrismaClient } from '../../../src/generated/prisma/client';
import type { KodaPrincipal } from '../../../src/auth/principal/koda-principal.types';
import { PermissionService } from '../../../src/permissions/permission.service';
import { MembershipService } from '../../../src/permissions/membership.service';
import { PrismaUsersRepository } from '../../../src/users/prisma-users.repository';
import { grantBaseline, grantRole } from '../../../src/permissions/test-helpers/permission-fixtures';
import { resetDb } from '../../helpers/reset-db';
import { bootHttpApp, loginToken, resetThrottle, TEST_PASSWORD } from '../../helpers/http-app';
import { expectGuardActive, fixtureDb } from '../../helpers/action-context';

const describeIntegration = process.env.KODA_DB_TESTS === '1' ? describe : describe.skip;
const principal = (id: string): KodaPrincipal => ({ actorType: 'user', id, role: 'MEMBER', email: `${id}@koda.test` }) as KodaPrincipal;

describeIntegration('bindings-only permission reads (PG)', () => {
  let app: NathApplication;
  let db: PrismaClient;
  let permissions: PermissionService;
  let membership: MembershipService;
  let users: PrismaUsersRepository;
  let passwordHash: string;
  let sequence = 0;
  const newUser = async (disabled = false) => {
    const n = ++sequence;
    return db.user.create({ data: { email: `bindings-${n}@koda.test`, name: `U${n}`, passwordHash, disabled } });
  };
  const newProject = () => {
    const n = ++sequence;
    return db.project.create({ data: { name: `P${n}`, slug: `bindings-${n}`, key: `B${n}` } });
  };
  const newAgent = () => {
    const n = ++sequence;
    return db.agent.create({ data: { name: `A${n}`, slug: `bindings-${n}`, apiKeyHash: `bindings-${n}` } });
  };
  beforeAll(async () => {
    await resetDb();
    passwordHash = await bcrypt.hash(TEST_PASSWORD, 4);
    app = await bootHttpApp({ registrationEnabled: false, ownerEmail: null });
    db = fixtureDb(app);
    permissions = app.get(PermissionService);
    membership = app.get(MembershipService);
    users = app.get(PrismaUsersRepository);
  }, 60_000);
  afterAll(async () => { await app?.close(); });
  beforeEach(async () => {
    await db.roleBinding.deleteMany({});
    await db.user.deleteMany({});
    await membership.invalidatePermissions();
    resetThrottle(app);
  });

  it('writes need an action context', async () => {
    await expect(expectGuardActive(app)).resolves.toBeUndefined();
  });

  it('AC-1: a baseline-only user has no project.read', async () => {
    const u = await newUser();
    const p = await newProject();
    await grantBaseline(db, { type: 'USER', id: u.id });
    await membership.invalidatePermissions();
    expect(await permissions.can(principal(u.id), 'project.read', { projectId: p.id })).toEqual({ allowed: false, reason: 'not-granted' });
  });

  it.each([[2, 'ticket.create'], [3, 'project.read']] as const)('AC-%i: a baseline-only agent has no %s', async (_ac, key) => {
    const a = await newAgent();
    const p = await newProject();
    await grantBaseline(db, { type: 'AGENT', id: a.id });
    await membership.invalidatePermissions();
    expect((await permissions.effectiveKeys({ type: 'AGENT', id: a.id }, { projectId: p.id })).has(key)).toBe(false);
  });

  it.each([4, 5])('AC-%i: an unbound user has no global or project keys', async (ac) => {
    const u = await newUser();
    const p = await newProject();
    await grantBaseline(db, { type: 'USER', id: u.id });
    await membership.invalidatePermissions();
    expect((await permissions.can(principal(u.id), ac === 4 ? 'project.read' : 'ticket.create', ac === 4 ? {} : { projectId: p.id })).allowed).toBe(false);
  });

  it('AC-6: no user binding means an empty global set', async () => {
    const u = await newUser();
    expect(await permissions.effectiveKeys({ type: 'USER', id: u.id }, 'global')).toEqual(new Set());
  });
  it('AC-7: global admin grants project keys without project bindings', async () => {
    const u = await newUser();
    const p = await newProject();
    await grantRole(db, { type: 'USER', id: u.id }, 'admin');
    await membership.invalidatePermissions();
    expect((await permissions.can(principal(u.id), 'ticket.create', { projectId: p.id })).allowed).toBe(true);
  });
  it('AC-9: the legacy admin mirror does not make a global admin', async () => {
    const u = await newUser();
    await grantBaseline(db, { type: 'USER', id: u.id });
    expect(await membership.isGlobalAdmin(u.id)).toBe(false);
  });
  it('AC-10: global owner is a global admin', async () => {
    const u = await newUser();
    await grantRole(db, { type: 'USER', id: u.id }, 'owner');
    expect(await membership.isGlobalAdmin(u.id)).toBe(true);
  });

  const updateActor = async () => {
    const c = await newUser();
    await grantBaseline(db, { type: 'USER', id: c.id });
    const role = await db.role.create({ data: { key: `update-${++sequence}`, name: 'User updater', scope: 'GLOBAL', permissions: ['user.update'] } });
    await grantRole(db, { type: 'USER', id: c.id }, role.key);
    await membership.invalidatePermissions();
    return loginToken(app.getHttpServer(), c.email);
  };
  it('AC-11: PATCH cannot disable the only bound admin despite a legacy ADMIN decoy', async () => {
    const token = await updateActor();
    const u1 = await newUser();
    const u2 = await newUser();
    await grantRole(db, { type: 'USER', id: u1.id }, 'admin');
    await grantBaseline(db, { type: 'USER', id: u2.id });
    await membership.invalidatePermissions();
    const res = await request(app.getHttpServer()).patch(`/api/admin/users/${u1.id}`).auth(token, { type: 'bearer' }).send({ disabled: true });
    expect(res.status).toBe(409);
    const translations = JSON.parse(readFileSync(join(__dirname, '../../../src/i18n/en/users.json'), 'utf8'));
    expect(res.body.message).toBe(translations.lastAdmin['409']);
    expect((await db.user.findUniqueOrThrow({ where: { id: u1.id } })).disabled).toBe(false);
  });
  it('AC-12: PATCH may disable an unbound legacy ADMIN when no bound admins exist', async () => {
    const token = await updateActor();
    const u2 = await newUser();
    await grantBaseline(db, { type: 'USER', id: u2.id });
    await membership.invalidatePermissions();
    await request(app.getHttpServer()).patch(`/api/admin/users/${u2.id}`).auth(token, { type: 'bearer' }).send({ disabled: true }).expect(200);
    expect((await db.user.findUniqueOrThrow({ where: { id: u2.id } })).disabled).toBe(true);
  });
  it('AC-13: active admin count uses distinct enabled bound users only', async () => {
    const enabled = await newUser();
    const disabled = await newUser(true);
    await newUser();
    await grantRole(db, { type: 'USER', id: enabled.id }, 'admin');
    await grantRole(db, { type: 'USER', id: enabled.id }, 'owner');
    await grantRole(db, { type: 'USER', id: disabled.id }, 'owner');
    expect(await users.countActiveAdmins()).toBe(1);
  });
  it('AC-14: no agent binding means an empty global set', async () => {
    const a = await newAgent();
    expect(await permissions.effectiveKeys({ type: 'AGENT', id: a.id }, 'global')).toEqual(new Set());
  });
});
