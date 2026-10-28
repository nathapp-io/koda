import request from 'supertest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { NathApplication } from '@nathapp/nestjs-app';
import { grantKeys } from '../../../src/approvals/test-helpers/approval-fixtures';
import { PermissionCache } from '../../../src/permissions/permission-cache';
import { RagService } from '../../../src/rag/rag.service';
import { fixtureDb } from '../../helpers/action-context';
import { bootHttpApp, data, resetThrottle } from '../../helpers/http-app';
import { seedFleetHttpAgent, seedFleetHttpWorld, type FleetHttpWorld } from '../../helpers/fleet-fixtures';
import { resetDb } from '../../helpers/reset-db';
import { canRunDbTests } from '../../helpers/test-environment';

const permissionsText = (JSON.parse(readFileSync(join(__dirname, '../../../src/i18n/en/permissions.json'), 'utf8')) as Record<string, string>)['40003'];
const describeDb = canRunDbTests() ? describe : describe.skip;
describeDb('gated KB document deletion', () => {
  let app: NathApplication;
  let db: ReturnType<typeof fixtureDb>;
  let rag: RagService;
  let world: FleetHttpWorld;
  let agent: Awaited<ReturnType<typeof seedFleetHttpAgent>>;
  let own: typeof agent;
  let keyless: typeof agent;
  let serial = 0;
  let sourceId: string;
  const server = () => app.getHttpServer();
  const auth = (token: string) => ({ Authorization: `Bearer ${token}` });
  const remove = (token = agent.apiKey, slug = 'web') => request(server()).delete(`/api/projects/${slug}/kb/documents/${sourceId}`).set(auth(token));
  const seed = async (creator = { type: 'USER' as const, id: world.ids.root }) => {
    for (const source of ['doc', 'manual']) await rag.indexDocument(world.projectId, { source, sourceId, content: 'document text', metadata: {}, createdBy: creator });
  };
  const creators = async () => Promise.all(['doc', 'manual'].map(source => rag.findSourceCreators(world.projectId, source, sourceId)));
  const pending = (res: request.Response) => {
    expect(res.status).toBe(202);
    expect(data(res)).toMatchObject({ permissionKey: 'kb.document.delete' });
    return data<{ id: string }>(res).id;
  };
  const approve = async (id: string) => data<{ status: string; result: unknown }>(await request(server()).post(`/api/approvals/${id}/decisions`).set(auth(world.tokens.root)).send({ decision: 'approve' }).expect(200));
  beforeAll(async () => {
    const previous = process.env.EMBEDDING_PROVIDER;
    process.env.EMBEDDING_PROVIDER = 'fake';
    try { await resetDb(); app = await bootHttpApp({ registrationEnabled: true, ownerEmail: null }); }
    finally { if (previous === undefined) delete process.env.EMBEDDING_PROVIDER; else process.env.EMBEDDING_PROVIDER = previous; }
    db = fixtureDb(app);
    rag = app.get(RagService);
    world = await seedFleetHttpWorld(server(), db);
    agent = await seedFleetHttpAgent(server(), world.tokens.root);
    own = await seedFleetHttpAgent(server(), world.tokens.root);
    keyless = await seedFleetHttpAgent(server(), world.tokens.root);
    for (const [actor, keys] of [[agent, ['project.read', 'kb.document.delete']], [own, ['project.read', 'kb.document.delete.own']], [keyless, ['project.read']]] as const) {
      await grantKeys(db, { type: 'AGENT', id: actor.id }, [...keys], world.projectId);
    }
    await app.get(PermissionCache).invalidate();
  }, 120_000);
  afterAll(async () => { await app?.close(); });
  beforeEach(async () => {
    resetThrottle(app);
    sourceId = `gated-${++serial}`;
    await db.approvalDecision.deleteMany();
    await db.approvalRequest.deleteMany();
  });
  it('AC-1: pending retains both sources', async () => {
    await seed(); pending(await remove());
    expect(await creators()).toEqual([[{ type: 'USER', id: world.ids.root }], [{ type: 'USER', id: world.ids.root }]]);
  });
  it('AC-2 / AC-3: approval deletes both sources, stores result and audits agent provenance per source', async () => {
    await seed(); const id = pending(await remove());
    expect(await approve(id)).toMatchObject({ status: 'executed', result: { deleted: true } });
    expect(await creators()).toEqual([[], []]);
    const audits = await db.auditEntry.findMany({ where: { key: 'kb.document.delete', approvalRequestId: id } });
    expect(audits).toHaveLength(2);
    expect(audits.map(row => row.resourceId).sort()).toEqual([`doc:${sourceId}`, `manual:${sourceId}`]);
    for (const row of audits) expect(row).toMatchObject({ actorType: 'AGENT', actorId: agent.id, approvalRequestId: id });
  });
  it('AC-4: ownership refusal precedes opening', async () => {
    await seed(); const res = await remove(own.apiKey);
    expect(res.status).toBe(403); expect(res.body.ret).toBe(40003); expect(res.body.message).toBe(permissionsText);
    expect(await db.approvalRequest.count()).toBe(0);
  });
  it('AC-5: missing project precedes opening with 404', async () => {
    const res = await remove(world.tokens.root, 'missing');
    expect(res.status).toBe(404); expect(res.body.ret).toBe(404);
    expect(await db.approvalRequest.count()).toBe(0);
  });
  it('AC-6: changed ownership fails at execution and keeps replacement rows', async () => {
    for (const source of ['doc', 'manual']) await rag.indexDocument(world.projectId, { source, sourceId, content: 'own', metadata: {}, createdBy: { type: 'AGENT', id: own.id } });
    const id = pending(await remove(own.apiKey));
    await seed();
    expect(await approve(id)).toMatchObject({ status: 'failed' });
    expect(await creators()).toEqual([[{ type: 'USER', id: world.ids.root }], [{ type: 'USER', id: world.ids.root }]]);
  });
  it('AC-7: root executes immediately without opening', async () => {
    await seed(); const res = await remove(world.tokens.root);
    expect(res.status).toBe(200); expect(data(res)).toEqual({ deleted: true });
    expect(await creators()).toEqual([[], []]);
    expect(await db.approvalRequest.count()).toBe(0);
  });
  it('AC-12: a keyless agent is refused before opening', async () => {
    await seed(); const res = await remove(keyless.apiKey);
    expect(res.status).toBe(403); expect(res.body.ret).toBe(40003); expect(res.body.message).toBe(permissionsText);
    expect(await db.approvalRequest.count()).toBe(0);
  });
});
