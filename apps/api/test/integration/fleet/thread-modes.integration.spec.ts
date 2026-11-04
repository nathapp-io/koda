import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import request from 'supertest';
import type { NathApplication } from '@nathapp/nestjs-app';
import { grantKeys } from '../../../src/approvals/test-helpers/approval-fixtures';
import { FLEET_CFG, type IFleetConfig } from '../../../src/config/fleet.config';
import { PermissionCache } from '../../../src/permissions/permission-cache';
import { grantRole, revokeProjectRoles } from '../../../src/permissions/test-helpers/permission-fixtures';
import { PrismaFleetJobRepository } from '../../../src/fleet/jobs/prisma-fleet-job.repository';
import { fixtureDb } from '../../helpers/action-context';
import { bootHttpApp, data, resetThrottle } from '../../helpers/http-app';
import { seedFleetHttpAgent, seedFleetHttpWorld, type FleetHttpWorld } from '../../helpers/fleet-fixtures';
import { resetDb } from '../../helpers/reset-db';
import { canRunDbTests } from '../../helpers/test-environment';

const describeDb = canRunDbTests() ? describe : describe.skip;
describeDb('thread modes persistence and authorization', () => {
  let app: NathApplication;
  let db: ReturnType<typeof fixtureDb>;
  let world: FleetHttpWorld;
  let agent: Awaited<ReturnType<typeof seedFleetHttpAgent>>;
  let n = 0;
  const path = '/api/projects/web/threads';
  const auth = (token: string) => ({ Authorization: `Bearer ${token}` });
  const body = (mode?: string) => ({ repoId: world.repoId, feature: `mode-${++n}`, title: 'Mode test', backend: { kind: 'native', model: 'm1' }, ...(mode ? { mode } : {}) });
  const create = (input: object, token = world.tokens.dev) => request(app.getHttpServer()).post(path).set(auth(token)).send(input);
  beforeAll(async () => {
    await resetDb();
    app = await bootHttpApp({ registrationEnabled: true, ownerEmail: null });
    db = fixtureDb(app);
    world = await seedFleetHttpWorld(app.getHttpServer(), db);
    app.get<IFleetConfig>(FLEET_CFG).threadsEnabled = true;
    await grantRole(db, { type: 'USER', id: world.ids.viewer }, 'project-admin', world.projectId);
    agent = await seedFleetHttpAgent(app.getHttpServer(), world.tokens.root);
    await grantKeys(db, { type: 'AGENT', id: agent.id }, ['project.read', 'thread.create', 'thread.mode.ask'], world.projectId);
    await app.get(PermissionCache).invalidate();
  }, 60_000);
  afterAll(async () => { await app?.close(); });
  beforeEach(() => resetThrottle(app));

  it('AC-6: migration appends ask exactly once, preserving edited developer grants', async () => {
    const role = await db.role.findUniqueOrThrow({ where: { key: 'developer' } });
    const sql = readFileSync(join(__dirname, '../../../prisma/migrations/20261124090000_thread_modes/migration.sql'), 'utf8');
    const update = sql.slice(sql.indexOf('UPDATE "Role"')).trim().replace(/;$/, '');
    try {
      await db.role.update({ where: { id: role.id }, data: { permissions: ['thread.create', '!ticket.delete'] } });
      await db.$executeRawUnsafe(update);
      await db.$executeRawUnsafe(update);
      expect((await db.role.findUniqueOrThrow({ where: { id: role.id } })).permissions).toEqual(['thread.create', '!ticket.delete', 'thread.mode.ask']);
    } finally {
      await db.role.update({ where: { id: role.id }, data: { permissions: role.permissions ?? [] } });
      await app.get(PermissionCache).invalidate();
    }
  });
  it.each([[undefined, 'read', 'AC-7'], ['ask', 'ask', 'AC-8']] as const)('%s create defaults/persists %s (%s)', async (mode, expected, _ac) => {
    const row = data<{ id: string; mode: string }>(await create(body(mode)).expect(201));
    expect(row.mode).toBe(expected);
    expect(await db.chatThread.findUniqueOrThrow({ where: { id: row.id } })).toMatchObject({ mode: expected, pendingApprovals: null });
  });
  it('AC-9: developer cannot create full and writes nothing', async () => {
    const input = body('full');
    await create(input).expect(403);
    expect(await db.chatThread.count({ where: { feature: input.feature } })).toBe(0);
  });
  it('AC-10: project admin creates full', async () => {
    const row = data<{ id: string; mode: string }>(await create(body('full'), world.tokens.viewer).expect(201));
    expect(row.mode).toBe('full');
    expect(await db.chatThread.findUniqueOrThrow({ where: { id: row.id } })).toMatchObject({ mode: 'full' });
  });
  it('AC-11: agent mode key defaults to approval; replay writes one ask thread', async () => {
    const input = body('ask');
    const pending = data<{ id: string }>(await create(input, agent.apiKey).expect(202));
    expect(await db.chatThread.count({ where: { feature: input.feature } })).toBe(0);
    const decision = data<{ status: string }>(await request(app.getHttpServer()).post(`/api/approvals/${pending.id}/decisions`).set(auth(world.tokens.root)).send({ decision: 'approve' }).expect(200));
    expect(decision.status).toBe('executed');
    const rows = await db.chatThread.findMany({ where: { feature: input.feature } });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ mode: 'ask', createdByType: 'AGENT' });
  });
  it('approval replay rechecks mode permission after revocation', async () => {
    const input = body('ask');
    const pending = data<{ id: string }>(await create(input, agent.apiKey).expect(202));
    const bindings = await db.roleBinding.findMany({ where: { principalId: agent.id, projectId: world.projectId } });
    const roles = await db.role.findMany({ where: { id: { in: bindings.map((b) => b.roleId) } } });
    try {
      for (const role of roles) await db.role.update({ where: { id: role.id }, data: { permissions: ['project.read', 'thread.create'] } });
      await app.get(PermissionCache).invalidate();
      const result = data<{ status: string }>(await request(app.getHttpServer()).post(`/api/approvals/${pending.id}/decisions`).set(auth(world.tokens.root)).send({ decision: 'approve' }).expect(200));
      expect(result.status).toBe('failed');
      expect(await db.chatThread.count({ where: { feature: input.feature } })).toBe(0);
    } finally {
      for (const role of roles) await db.role.update({ where: { id: role.id }, data: { permissions: role.permissions ?? [] } });
      await app.get(PermissionCache).invalidate();
    }
  });
  it.each(['PROJECT', 'WORKSPACE'])('AC-12: %s refuses ask with mode in the validation response', async (kind) => {
    const res = kind === 'PROJECT'
      ? await create({ kind, mode: 'ask', title: 'No worktree', backend: { kind: 'native' } }).expect(400)
      : await request(app.getHttpServer()).post('/api/threads').set(auth(world.tokens.dev)).send({ kind, mode: 'ask', title: 'No worktree', backend: { kind: 'native' } }).expect(400);
    expect(JSON.stringify(res.body)).toContain('mode');
  });
  it('messages retain full after creator revocation, and any-row send needs no mode grant', async () => {
    const ownerThread = data<{ id: string }>(await create(body('full'), world.tokens.viewer).expect(201));
    const otherThread = data<{ id: string }>(await create(body('full'), world.tokens.viewer).expect(201));
    const creator = { type: 'USER', id: world.ids.viewer } as const;
    try {
      await revokeProjectRoles(db, creator, world.projectId);
      await grantRole(db, creator, 'developer', world.projectId);
      await grantKeys(db, { type: 'USER', id: world.ids.outsider }, ['project.read', 'thread.message.send'], world.projectId);
      await app.get(PermissionCache).invalidate();
      for (const [thread, token] of [[ownerThread, world.tokens.viewer], [otherThread, world.tokens.outsider]] as const) {
        const sent = data<{ jobId: string }>(await request(app.getHttpServer()).post(`${path}/${thread.id}/messages`).set(auth(token)).send({ text: 'continue', clientMessageId: `retain-${++n}` }).expect(201));
        expect(await app.get(PrismaFleetJobRepository).findThreadAssign(sent.jobId)).toMatchObject({ mode: 'full' });
      }
    } finally {
      await revokeProjectRoles(db, creator, world.projectId);
      await grantRole(db, creator, 'project-admin', world.projectId);
      await revokeProjectRoles(db, { type: 'USER', id: world.ids.outsider }, world.projectId);
      await app.get(PermissionCache).invalidate();
    }
  });
  it('AC-14: assign uses the immutable turn even when the thread changes', async () => {
    const row = data<{ id: string }>(await create(body()).expect(201));
    const sent = data<{ jobId: string }>(await request(app.getHttpServer()).post(`${path}/${row.id}/messages`).set(auth(world.tokens.dev)).send({ text: 'hello', clientMessageId: `immutable-${++n}` }).expect(201));
    await db.chatThread.update({ where: { id: row.id }, data: { mode: 'full' } });
    expect(await app.get(PrismaFleetJobRepository).findThreadAssign(sent.jobId)).toMatchObject({ mode: 'read' });
  });
  it('AC-13: first message snapshots the mode; later thread edits cannot change its assign', async () => {
    const row = data<{ id: string }>(await create(body('ask')).expect(201));
    const sent = data<{ jobId: string }>(await request(app.getHttpServer()).post(`${path}/${row.id}/messages`).set(auth(world.tokens.dev)).send({ text: 'hello', clientMessageId: `msg-${++n}` }).expect(201));
    const jobs = app.get(PrismaFleetJobRepository);
    expect(await jobs.findThreadAssign(sent.jobId)).toMatchObject({ mode: 'ask' });
    expect(await db.fleetThreadTurn.findUniqueOrThrow({ where: { jobId: sent.jobId } })).toMatchObject({ mode: 'ask' });
    await db.chatThread.update({ where: { id: row.id }, data: { mode: 'full' } });
    expect(await jobs.findThreadAssign(sent.jobId)).toMatchObject({ mode: 'ask' });
  });
});
