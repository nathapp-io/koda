import request from 'supertest';
import type { NathApplication } from '@nathapp/nestjs-app';
import { fixtureDb } from '../../helpers/action-context';
import { bootHttpApp, data, resetThrottle } from '../../helpers/http-app';
import { seedFleetHttpWorld, type FleetHttpWorld } from '../../helpers/fleet-fixtures';
import { resetDb } from '../../helpers/reset-db';
import { canRunDbTests } from '../../helpers/test-environment';
import { grantRole } from '../../../src/permissions/test-helpers/permission-fixtures';
import { PermissionCache } from '../../../src/permissions/permission-cache';
import { AuditRecorder } from '../../../src/audit/audit-recorder.service';
import { collectPermissionDeclarations } from '../../../src/permissions/test-helpers/permission-contract';
import { ModulesContainer } from '@nestjs/core';
import { AssistantToolRegistry } from '../../../src/fleet/assistant/assistant-tool.registry';

const describeDb = canRunDbTests() ? describe : describe.skip;
describeDb('decision retirement REST', () => {
  let app: NathApplication;
  let db: ReturnType<typeof fixtureDb>;
  let world: FleetHttpWorld;
  let seq = 0;
  const auth = (who: keyof FleetHttpWorld['tokens']) => ({ Authorization: `Bearer ${world.tokens[who]}` });
  beforeAll(async () => {
    await resetDb();
    app = await bootHttpApp({ registrationEnabled: true, ownerEmail: null });
    db = fixtureDb(app);
    world = await seedFleetHttpWorld(app.getHttpServer(), db);
    await grantRole(db, { type: 'USER', id: world.ids.outsider }, 'developer', world.opsProjectId);
    // Use the viewer account as a project-admin only in the specific happy-path test.
    await app.get(PermissionCache).invalidate();
  }, 60000);
  beforeEach(() => resetThrottle(app));
  afterAll(async () => { await app?.close(); });
  const item = (over: { kind?: string; status?: string; deletedAt?: Date } = {}) => db.memoryItem.create({ data: {
    projectId: world.projectId, kind: 'DECISION', subject: `repo:${world.repoId}`, predicate: `finding-${++seq}`,
    object: 'Not a defect', sourceType: 'review_event', sourceId: `review-${seq}`, activeKey: `retire-${seq}`, status: 'active', ...over,
  } });
  const retire = (id: string, who: keyof FleetHttpWorld['tokens'] = 'root', body: object = {}) => request(app.getHttpServer()).post(`/api/memory/${id}/retire`).set(auth(who)).send(body);

  it('AC-3/4/5/6: project-admin retires a review decision atomically with reason audit', async () => {
    await grantRole(db, { type: 'USER', id: world.ids.viewer }, 'project-admin', world.projectId);
    await app.get(PermissionCache).invalidate();
    try {
      const target = await item();
      await retire(target.id, 'viewer', { reason: 'wrong call' }).expect(201);
      expect(await db.memoryItem.findUniqueOrThrow({ where: { id: target.id } })).toMatchObject({ status: 'rejected', activeKey: null });
      const entries = await db.auditEntry.findMany({ where: { resourceId: target.id, key: 'memory.decision.retire' } });
      expect(entries).toHaveLength(1);
      expect(entries[0].summary).toContain('wrong call');
    } finally {
      const role = await db.role.findUniqueOrThrow({ where: { key: 'project-admin' } });
      await db.roleBinding.deleteMany({ where: { principalId: world.ids.viewer, roleId: role.id } });
      await app.get(PermissionCache).invalidate();
    }
  });
  it('AC-7: developer retires its own recorded decision', async () => {
    await request(app.getHttpServer()).post('/api/memory/decisions').set(auth('dev')).send({ projectId: world.projectId, topic: 'own', decision: 'yes' }).expect(201);
    const target = await db.memoryItem.findFirstOrThrow({ where: { projectId: world.projectId, ownerId: world.ids.dev, predicate: 'own' } });
    await retire(target.id, 'dev').expect(201);
  });
  it('AC-8: developer cannot retire an ownerless review decision', async () => {
    const target = await item();
    await retire(target.id, 'dev').expect(403);
    expect(await db.memoryItem.findUniqueOrThrow({ where: { id: target.id } })).toMatchObject({ status: 'active', activeKey: target.activeKey });
    expect(await db.auditEntry.count({ where: { resourceId: target.id, key: 'memory.decision.retire' } })).toBe(0);
  });
  it('AC-9: viewer is refused', async () => { await retire((await item()).id, 'viewer').expect(403); });
  it('AC-10: member of Q cannot discover P decision', async () => {
    const response = await retire((await item()).id, 'outsider').expect(404);
    expect(response.body.message).toBe('Memory item not found');
  });
  it('AC-11: unknown id is memory.notFound', async () => {
    const response = await retire('unknown').expect(404);
    expect(response.body.message).toBe('Memory item not found');
  });
  it('soft-deleted decision is hidden', async () => { await retire((await item({ deletedAt: new Date() })).id).expect(404); });
  it('AC-12: FACT is memory.retireNotDecision', async () => {
    const response = await retire((await item({ kind: 'FACT' })).id).expect(422);
    expect(response.body.message).toBe('Only decisions can be retired');
  });
  it('AC-13: superseded decision is memory.retireNotActive', async () => {
    const response = await retire((await item({ status: 'superseded' })).id).expect(409);
    expect(response.body.message).toBe('Only active decisions can be retired');
  });
  it('AC-14: reason is bounded to 500 characters', async () => {
    await retire((await item()).id, 'root', { reason: 'x'.repeat(501) }).expect(400);
  });
  it('accepts exactly 500 characters and rejects a second retirement', async () => {
    const target = await item();
    await retire(target.id, 'root', { reason: 'x'.repeat(500) }).expect(201);
    await retire(target.id).expect(409);
    expect(await db.auditEntry.count({ where: { resourceId: target.id, key: 'memory.decision.retire' } })).toBe(1);
  });
  it('rolls the retirement back when audit persistence fails', async () => {
    const target = await item();
    const spy = vi.spyOn(app.get(AuditRecorder), 'record').mockRejectedValueOnce(new Error('audit unavailable'));
    try {
      await retire(target.id).expect(500);
    } finally { spy.mockRestore(); }
    expect(await db.memoryItem.findUniqueOrThrow({ where: { id: target.id } })).toMatchObject({ status: 'active', activeKey: target.activeKey });
    expect(await db.auditEntry.count({ where: { resourceId: target.id, key: 'memory.decision.retire' } })).toBe(0);
  });
  it('AC-15: booted permission contract declares gated retirement', () => {
    const declarations = collectPermissionDeclarations(app.get(ModulesContainer), app.get(AssistantToolRegistry));
    expect(declarations.routes.find((route) => route.route === 'POST /memory/:id/retire')).toMatchObject({ gated: true, requires: { keys: ['memory.decision.retire'] } });
  });
});
