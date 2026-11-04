import { canRunDbTests } from '../../helpers/test-environment';
/**
 * The `PATCH /api/fleet/repos/:id/fix-unprotected` route: the repo-level, default-off, audited override that
 * lets a FIX mint write credentials although the default branch is unprotected. Same key, gate and
 * refusals as the fix-checks route.
 *
 * Run: cd apps/api && bun run test:db:up && KODA_DB_TESTS=1 bunx vitest run test/integration/fleet/fleet-repo-fix-unprotected-route.integration.spec.ts
 */
import request from 'supertest';
import type { NathApplication } from '@nathapp/nestjs-app';
import { grantKeys } from '../../../src/approvals/test-helpers/approval-fixtures';
import { PermissionCache } from '../../../src/permissions/permission-cache';
import { fixtureDb } from '../../helpers/action-context';
import { bootHttpApp, data, resetThrottle } from '../../helpers/http-app';
import { seedFleetHttpAgent, seedFleetHttpWorld, type FleetHttpWorld } from '../../helpers/fleet-fixtures';
import { resetDb } from '../../helpers/reset-db';

// The nax sandbox withholds host Postgres/Docker.
const describeIntegration = canRunDbTests() ? describe : describe.skip;
const KEY = 'fleet.repo.fix.unprotected';

interface RepoBody { id: string; fixAllowUnprotected: boolean }
interface Pending { id: string; permissionKey: string; projectId: string | null }
interface Decided { status: string; result: unknown }

describeIntegration('fleet repo fix-unprotected route (PG)', () => {
  let app: NathApplication;
  let db: ReturnType<typeof fixtureDb>;
  let world: FleetHttpWorld;
  let agent: Awaited<ReturnType<typeof seedFleetHttpAgent>>;
  let seq = 0;
  const server = () => app.getHttpServer();
  const auth = (token: string) => ({ Authorization: `Bearer ${token}` });
  const patch = (id: string, body: object, token?: string) =>
    request(server()).patch(`/api/fleet/repos/${id}/fix-unprotected`).set(auth(token ?? world.tokens.root)).send(body);

  /** A fresh repo on the seeded project, so no case reads a row another case wrote. */
  const repo = (over: Record<string, unknown> = {}) => db.fleetRepo.create({
    data: {
      projectId: world.projectId, provider: 'github', owner: 'acme', name: `unprot-${++seq}`,
      defaultBranch: 'main', githubInstallationId: BigInt(77), createdById: world.ids.root, ...over,
    },
  });

  const stored = (id: string) => db.fleetRepo.findUniqueOrThrow({ where: { id } });
  const approve = async (id: string) => data<Decided>(
    await request(server()).post(`/api/approvals/${id}/decisions`).set(auth(world.tokens.root))
      .send({ decision: 'approve' }).expect(200),
  );

  beforeAll(async () => {
    await resetDb();
    app = await bootHttpApp({ registrationEnabled: true, ownerEmail: null });
    db = fixtureDb(app);
    world = await seedFleetHttpWorld(server(), db);
    agent = await seedFleetHttpAgent(server(), world.tokens.root);
    // The agent holds the global route key so it reaches the handler; it needs nothing else, because
    // enabling the override does not ask the caller to be able to dispatch.
    await grantKeys(db, { type: 'AGENT', id: agent.id }, [KEY], null);
    await app.get(PermissionCache).invalidate();
  }, 90_000);

  afterAll(async () => { await app?.close(); });

  beforeEach(async () => {
    resetThrottle(app);
    await db.approvalDecision.deleteMany();
    await db.approvalRequest.deleteMany();
    await db.approvalPolicy.deleteMany();
  });

  it('a user holding the key globally enables the override on a GitHub repo', async () => {
    const target = await repo();
    const body = data<RepoBody>(await patch(target.id, { allowUnprotected: true }).expect(200));
    expect(body).toMatchObject({ id: target.id, fixAllowUnprotected: true });
    expect((await stored(target.id)).fixAllowUnprotected).toBe(true);
    // The setting is an audited repo write, under the key the route already asks for.
    expect(await db.auditEntry.findFirst({ where: { key: KEY, resourceId: target.id, summary: 'fix on unprotected default branch allowed' } }))
      .toMatchObject({ resourceType: 'fleet-repo', projectId: world.projectId });
  });

  it('disabling answers 200 with fixAllowUnprotected false and stores it', async () => {
    const target = await repo({ fixAllowUnprotected: true });
    const body = data<RepoBody>(await patch(target.id, { allowUnprotected: false }).expect(200));
    expect(body).toMatchObject({ id: target.id, fixAllowUnprotected: false });
    expect((await stored(target.id)).fixAllowUnprotected).toBe(false);
    expect(await db.auditEntry.findFirst({ where: { key: KEY, resourceId: target.id, summary: 'fix on unprotected default branch disallowed' } }))
      .toMatchObject({ resourceType: 'fleet-repo', projectId: world.projectId });
  });

  it('enabling on a GitLab repo answers 422 with the github app reason and stores nothing', async () => {
    const target = await repo({ provider: 'gitlab', githubInstallationId: null });
    const res = await patch(target.id, { allowUnprotected: true }).expect(422);
    expect(JSON.stringify(res.body)).toContain('github app required');
    // The refusal is worded by the module's own 422 message, not a bare reason code.
    expect(String(res.body.message)).toContain('FIX on an unprotected default branch cannot be allowed: github app required');
    expect((await stored(target.id)).fixAllowUnprotected).toBe(false);
  });

  it('enabling on a GitHub repo without an installation answers 422 with the github app reason', async () => {
    const target = await repo({ githubInstallationId: null });
    const res = await patch(target.id, { allowUnprotected: true }).expect(422);
    expect(String(res.body.message)).toContain('FIX on an unprotected default branch cannot be allowed: github app required');
    expect((await stored(target.id)).fixAllowUnprotected).toBe(false);
  });

  it('disabling on a GitLab repo answers 200 with fixAllowUnprotected false', async () => {
    const target = await repo({ provider: 'gitlab', githubInstallationId: null, fixAllowUnprotected: true });
    const body = data<RepoBody>(await patch(target.id, { allowUnprotected: false }).expect(200));
    expect(body).toMatchObject({ id: target.id, fixAllowUnprotected: false });
    expect((await stored(target.id)).fixAllowUnprotected).toBe(false);
  });

  it('an unknown repo id answers 404 from the repo lookup, not from a missing route', async () => {
    const res = await patch('no-such-repo', { allowUnprotected: true }).expect(404);
    // The domain refusal, so a missing route's "Cannot PATCH ..." body does not answer this AC.
    expect(JSON.stringify(res.body)).toContain('Fleet repository not found');
  });

  it.each([
    ['without the field', {}],
    ['with a non-boolean value', { allowUnprotected: 'yes' }],
  ])('a body %s answers 400 and leaves the row unchanged', async (_label, body) => {
    const target = await repo();
    await patch(target.id, body).expect(400);
    expect((await stored(target.id)).fixAllowUnprotected).toBe(false);
    expect(await db.approvalRequest.count()).toBe(0);
  });

  it('a user without the global key is refused with 403 and the row is unchanged', async () => {
    const target = await repo();
    await patch(target.id, { allowUnprotected: true }, world.tokens.dev).expect(403);
    expect((await stored(target.id)).fixAllowUnprotected).toBe(false);
    expect(await db.approvalRequest.count()).toBe(0);
  });

  it('an agent with no approval policy waits with 202 and changes nothing', async () => {
    const target = await repo();
    const summary = data<Pending>(await patch(target.id, { allowUnprotected: true }, agent.apiKey).expect(202));
    expect(summary).toMatchObject({ permissionKey: KEY, projectId: null });
    expect((await stored(target.id)).fixAllowUnprotected).toBe(false);
    expect((await db.approvalRequest.findUniqueOrThrow({ where: { id: summary.id } })).status).toBe('pending');
  });

  it('approving that request stores the setting', async () => {
    const target = await repo();
    const summary = data<Pending>(await patch(target.id, { allowUnprotected: true }, agent.apiKey).expect(202));
    expect((await approve(summary.id)).status).toBe('executed');
    expect((await stored(target.id)).fixAllowUnprotected).toBe(true);
    expect(await db.auditEntry.findFirst({ where: { key: KEY, resourceId: target.id, summary: 'fix on unprotected default branch allowed' } }))
      .toMatchObject({ resourceType: 'fleet-repo' });
  });

  it('a row created without the setting is listed with fixAllowUnprotected false', async () => {
    const created = await repo();
    const enabled = await repo({ fixAllowUnprotected: true });
    // The migration default, not a value the fixture wrote.
    expect((await stored(created.id)).fixAllowUnprotected).toBe(false);

    const page = data<{ records: RepoBody[] }>(
      await request(server()).get('/api/fleet/repos').set(auth(world.tokens.root)).expect(200),
    );
    expect(page.records.map((record) => record.id)).toEqual(expect.arrayContaining([created.id, enabled.id]));
    expect(page.records.find((record) => record.id === created.id)).toMatchObject({ fixAllowUnprotected: false });
    expect(page.records.find((record) => record.id === enabled.id)).toMatchObject({ fixAllowUnprotected: true });
  });
});
