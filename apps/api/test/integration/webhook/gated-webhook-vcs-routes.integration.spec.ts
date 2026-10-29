import request from 'supertest';
import type { NathApplication } from '@nathapp/nestjs-app';
import { NotFoundAppException } from '@nathapp/nestjs-common';
import { grantKeys } from '../../../src/approvals/test-helpers/approval-fixtures';
import { PermissionCache } from '../../../src/permissions/permission-cache';
import { GitHubProvider } from '../../../src/vcs/providers/github.provider';
import { fixtureDb } from '../../helpers/action-context';
import { bootHttpApp, data, resetThrottle } from '../../helpers/http-app';
import { seedFleetHttpAgent, seedFleetHttpWorld, type FleetHttpWorld } from '../../helpers/fleet-fixtures';
import { resetDb } from '../../helpers/reset-db';
import { canRunDbTests } from '../../helpers/test-environment';

const describeIntegration = canRunDbTests() ? describe : describe.skip;
interface Pending { id: string; permissionKey: string; projectId: string | null }
interface Settled { status: string; result: unknown }

describeIntegration('gated webhook and VCS routes', () => {
  let app: NathApplication;
  let db: ReturnType<typeof fixtureDb>;
  let world: FleetHttpWorld;
  let agent: Awaited<ReturnType<typeof seedFleetHttpAgent>>;
  let globalAgent: Awaited<ReturnType<typeof seedFleetHttpAgent>>;
  let p: { id: string; slug: string };
  let other: { id: string; slug: string };
  const server = () => app.getHttpServer();
  const auth = (token = agent.apiKey) => ({ Authorization: `Bearer ${token}` });
  const root = () => auth(world.tokens.root);
  const pending = (res: request.Response) => { expect(res.status).toBe(202); return data<Pending>(res); };
  const approve = async (id: string) => data<Settled>(await request(server()).post(`/api/approvals/${id}/decisions`).set(root()).send({ decision: 'approve' }).expect(200));
  const webhook = (projectId = p.id) => db.webhook.create({ data: { projectId, url: 'https://93.184.215.14/hook', secret: 'fixture-secret', events: '[]' } });
  const createConnection = () => request(server()).post(`/api/projects/${p.slug}/vcs`).set(root()).send({ provider: 'github', repoOwner: 'acme', repoName: 'widgets', token: 'fixture-token', syncMode: 'off' }).expect(201);

  beforeAll(async () => {
    vi.stubEnv('VCS_ENCRYPTION_KEY', 'ab'.repeat(32));
    await resetDb();
    app = await bootHttpApp({ registrationEnabled: true, ownerEmail: null });
    db = fixtureDb(app);
    world = await seedFleetHttpWorld(server(), db);
    const createProject = async (slug: string, key: string) => data<{ id: string; slug: string }>(await request(server()).post('/api/projects').set(root()).send({ slug, key, name: slug }).expect(201));
    p = await createProject('gated-p', 'GATEP');
    other = await createProject('gated-q', 'GATEQ');
    agent = await seedFleetHttpAgent(server(), world.tokens.root);
    globalAgent = await seedFleetHttpAgent(server(), world.tokens.root);
    await grantKeys(db, { type: 'AGENT', id: agent.id }, ['project.read', 'webhook.delete', 'vcs.connection.delete', 'vcs.connection.test'], p.id);
    await grantKeys(db, { type: 'AGENT', id: globalAgent.id }, ['webhook.delete'], null);
    await app.get(PermissionCache).invalidate();
  }, 60000);
  beforeEach(async () => {
    resetThrottle(app);
    await db.approvalDecision.deleteMany();
    await db.approvalRequest.deleteMany();
    await db.vcsConnection.deleteMany({ where: { projectId: p.id } });
  });
  afterEach(() => vi.restoreAllMocks());
  afterAll(async () => { await app?.close(); vi.unstubAllEnvs(); });

  it('AC-1: project delete waits and root approval removes the webhook', async () => {
    const row = await webhook();
    const summary = pending(await request(server()).delete(`/api/projects/${p.slug}/webhooks/${row.id}`).set(auth()));
    expect(summary.permissionKey).toBe('webhook.delete');
    expect(await db.webhook.findUnique({ where: { id: row.id } })).not.toBeNull();
    expect((await approve(summary.id)).status).toBe('executed');
    expect(await db.webhook.findUnique({ where: { id: row.id } })).toBeNull();
  });
  it('AC-2: cross-project delete waits, then fails without deleting the other webhook', async () => {
    const row = await webhook(other.id);
    const summary = pending(await request(server()).delete(`/api/projects/${p.slug}/webhooks/${row.id}`).set(auth()));
    expect(await approve(summary.id)).toMatchObject({ status: 'failed', result: { error: 'execution-failed', name: new NotFoundAppException({}, 'webhooks').name } });
    expect(await db.webhook.findUnique({ where: { id: row.id } })).not.toBeNull();
  });
  it('AC-3: global delete has null scope and runs after approval', async () => {
    const row = await webhook();
    const summary = pending(await request(server()).delete(`/api/webhooks/${row.id}`).set(auth(globalAgent.apiKey)));
    expect(summary.projectId).toBeNull();
    expect((await approve(summary.id)).status).toBe('executed');
    expect(await db.webhook.findUnique({ where: { id: row.id } })).toBeNull();
  });
  it('AC-4: root delete returns 204 without an approval row', async () => {
    const row = await webhook();
    await request(server()).delete(`/api/projects/${p.slug}/webhooks/${row.id}`).set(root()).expect(204);
    expect(await db.webhook.findUnique({ where: { id: row.id } })).toBeNull();
    expect(await db.approvalRequest.count()).toBe(0);
  });
  it('AC-5: VCS delete waits and approved execution removes the connection', async () => {
    await createConnection();
    const summary = pending(await request(server()).delete(`/api/projects/${p.slug}/vcs`).set(auth()));
    expect(await db.vcsConnection.findUnique({ where: { projectId: p.id } })).not.toBeNull();
    expect((await approve(summary.id)).status).toBe('executed');
    expect(await db.vcsConnection.findUnique({ where: { projectId: p.id } })).toBeNull();
  });
  it.each([true, false])('AC-6: VCS test freezes only projectId and stores the service DTO (ok=%s)', async (ok) => {
    await createConnection();
    const test = vi.spyOn(GitHubProvider.prototype, 'testConnection').mockResolvedValue(ok ? { ok: true } : { ok: false, error: 'Invalid token' });
    const summary = pending(await request(server()).post(`/api/projects/${p.slug}/vcs/test`).set(auth()));
    expect(summary.permissionKey).toBe('vcs.connection.test');
    expect((await db.approvalRequest.findUniqueOrThrow({ where: { id: summary.id } })).input).toEqual({ projectId: p.id });
    expect(test).not.toHaveBeenCalled();
    const settled = await approve(summary.id);
    expect(settled).toMatchObject({ status: 'executed', result: { ok, latencyMs: expect.any(Number), ...(!ok && { error: 'Invalid token' }) } });
    expect(test).toHaveBeenCalledOnce();
  });
  it('AC-8: approved VCS test settles when provider polling updates connection timestamps', async () => {
    await createConnection();
    const test = vi.spyOn(GitHubProvider.prototype, 'testConnection').mockImplementation(async () => {
      await db.vcsConnection.update({
        where: { projectId: p.id },
        data: { lastSyncedAt: new Date('2026-01-02T03:04:05Z') },
      });
      return { ok: true };
    });

    const summary = pending(await request(server()).post(`/api/projects/${p.slug}/vcs/test`).set(auth()));
    const settled = await approve(summary.id);

    expect(settled).toMatchObject({ status: 'executed', result: { ok: true, latencyMs: expect.any(Number) } });
    expect(test).toHaveBeenCalledOnce();
    expect(await db.vcsConnection.findUniqueOrThrow({ where: { projectId: p.id } })).toMatchObject({
      lastSyncedAt: new Date('2026-01-02T03:04:05Z'),
    });
  });

  it('AC-7: immediate root VCS test retains default POST 201 and opens no request', async () => {
    await createConnection();
    const test = vi.spyOn(GitHubProvider.prototype, 'testConnection').mockResolvedValue({ ok: true });
    const res = await request(server()).post(`/api/projects/${p.slug}/vcs/test`).set(root()).expect(201);
    expect(data(res)).toEqual({ ok: true, latencyMs: expect.any(Number) });
    expect(test).toHaveBeenCalledOnce();
    expect(await db.approvalRequest.count()).toBe(0);
  });
});
