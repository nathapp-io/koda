import request from 'supertest';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { NathApplication } from '@nathapp/nestjs-app';
import { NotFoundAppException } from '@nathapp/nestjs-common';
import { grantKeys } from '../../../src/approvals/test-helpers/approval-fixtures';
import { PermissionCache } from '../../../src/permissions/permission-cache';
import { fixtureDb } from '../../helpers/action-context';
import { bootHttpApp, data, resetThrottle } from '../../helpers/http-app';
import { seedFleetHttpAgent, seedFleetHttpWorld, type FleetHttpWorld } from '../../helpers/fleet-fixtures';
import { resetDb } from '../../helpers/reset-db';
import { canRunDbTests } from '../../helpers/test-environment';

const describeIntegration = canRunDbTests() ? describe : describe.skip;
interface Pending { id: string; permissionKey: string; projectId: string | null }
interface Settled { status: string; result: unknown }

describeIntegration('gated project, agent and skill-source deletes', () => {
  let app: NathApplication;
  let db: ReturnType<typeof fixtureDb>;
  let world: FleetHttpWorld;
  let actor: Awaited<ReturnType<typeof seedFleetHttpAgent>>;
  let keyless: Awaited<ReturnType<typeof seedFleetHttpAgent>>;
  const server = () => app.getHttpServer();
  const remove = (path: string, token = actor.apiKey) => request(server()).delete(`/api/${path}`).auth(token, { type: 'bearer' });
  const pending = (res: request.Response) => {
    expect(res.status).toBe(202);
    return data<Pending>(res);
  };
  const approve = async (id: string) => data<Settled>(await request(server()).post(`/api/approvals/${id}/decisions`)
    .auth(world.tokens.root, { type: 'bearer' }).send({ decision: 'approve' }).expect(200));
  const project = () => db.project.create({ data: { name: 'Delete me', slug: `delete-${randomUUID()}`, key: `D${randomUUID().slice(0, 6)}` } });
  const source = () => db.skillSource.create({ data: {
    gitUrl: `https://github.com/acme/${randomUUID()}`, owner: 'acme', repo: randomUUID(), ref: 'main', path: '', status: 'OK', createdById: world.ids.root,
  } });
  beforeAll(async () => {
    await resetDb();
    app = await bootHttpApp({ registrationEnabled: true, ownerEmail: null });
    db = fixtureDb(app);
    world = await seedFleetHttpWorld(server(), db);
    actor = await seedFleetHttpAgent(server(), world.tokens.root);
    keyless = await seedFleetHttpAgent(server(), world.tokens.root);
    await grantKeys(db, { type: 'AGENT', id: actor.id }, ['agent.delete', 'skill.source.delete'], null);
    await app.get(PermissionCache).invalidate();
  }, 60_000);
  afterAll(async () => { await app?.close(); });
  beforeEach(async () => {
    resetThrottle(app);
    await db.approvalDecision.deleteMany();
    await db.approvalRequest.deleteMany();
    await db.approvalPolicy.deleteMany();
  });
  it('AC-1: project deletion waits, then soft-deletes after root approval', async () => {
    const p = await project();
    await grantKeys(db, { type: 'AGENT', id: actor.id }, ['project.read', 'project.delete'], p.id);
    await app.get(PermissionCache).invalidate();
    const summary = pending(await remove(`projects/${p.slug}`));
    expect(summary).toMatchObject({ permissionKey: 'project.delete', projectId: p.id });
    expect((await db.project.findUniqueOrThrow({ where: { id: p.id } })).deletedAt).toBeNull();
    expect((await approve(summary.id)).status).toBe('executed');
    expect((await db.project.findUniqueOrThrow({ where: { id: p.id } })).deletedAt).toBeInstanceOf(Date);
  });
  it('AC-2: root project deletion preserves 204 and opens no request', async () => {
    const p = await project();
    await remove(`projects/${p.slug}`, world.tokens.root).expect(204);
    expect((await db.project.findUniqueOrThrow({ where: { id: p.id } })).deletedAt).toBeInstanceOf(Date);
    expect(await db.approvalRequest.count()).toBe(0);
  });
  it('AC-3/AC-4: agent deletion waits, hard-deletes and stores the deleted DTO', async () => {
    const target = await seedFleetHttpAgent(server(), world.tokens.root);
    const summary = pending(await remove(`agents/${target.slug}`));
    expect(summary).toMatchObject({ permissionKey: 'agent.delete', projectId: null });
    expect(await db.agent.findUnique({ where: { id: target.id } })).not.toBeNull();
    expect(await approve(summary.id)).toMatchObject({ status: 'executed', result: { slug: target.slug } });
    expect(await db.agent.findUnique({ where: { id: target.id } })).toBeNull();
  });
  it('AC-5: root agent deletion preserves 200 and opens no request', async () => {
    const target = await seedFleetHttpAgent(server(), world.tokens.root);
    const res = await remove(`agents/${target.slug}`, world.tokens.root).expect(200);
    expect(data(res)).toMatchObject({ slug: target.slug });
    expect(await db.agent.findUnique({ where: { id: target.id } })).toBeNull();
    expect(await db.approvalRequest.count()).toBe(0);
  });
  it('AC-6: source deletion waits then deletes on approval', async () => {
    const s = await source();
    const summary = pending(await remove(`admin/skills/sources/${s.id}`));
    expect(summary).toMatchObject({ permissionKey: 'skill.source.delete', projectId: null });
    expect(await db.skillSource.findUnique({ where: { id: s.id } })).not.toBeNull();
    expect(await approve(summary.id)).toMatchObject({ status: 'executed', result: null });
    expect(await db.skillSource.findUnique({ where: { id: s.id } })).toBeNull();
  });
  it('AC-7: a source deleted by root while waiting settles failed with the service exception name', async () => {
    const s = await source();
    const summary = pending(await remove(`admin/skills/sources/${s.id}`));
    await remove(`admin/skills/sources/${s.id}`, world.tokens.root).expect(204);
    expect(await approve(summary.id)).toMatchObject({ status: 'failed', result: {
      error: 'execution-failed', name: new NotFoundAppException({}, 'skills.sourceNotFound').name,
    } });
  });
  it('AC-8: a keyless agent receives permissions 403 without opening a request', async () => {
    const target = await seedFleetHttpAgent(server(), world.tokens.root);
    const res = await remove(`agents/${target.slug}`, keyless.apiKey).expect(403);
    expect(res.body.ret).toBe(40003);
    const permissions = JSON.parse(readFileSync(join(__dirname, '../../../src/i18n/en/permissions.json'), 'utf8')) as Record<string, string>;
    expect(res.body.message).toBe(permissions['40003']);
    expect(await db.approvalRequest.count()).toBe(0);
    expect(await db.agent.findUnique({ where: { id: target.id } })).not.toBeNull();
  });
});
