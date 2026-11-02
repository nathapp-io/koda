import { canRunDbTests } from '../../helpers/test-environment';
/**
 * Fleet FIX US-001 — the `PATCH /api/fleet/repos/:id/fix-checks` route.
 *
 * `nax bot fix` refuses a PR whose base branch has no nax check commands; this repo-level, default-off
 * switch lets a human allow FIX to run the checks it detects. The route is a global, approvable write
 * under the existing `fleet.repo.review.configure` key: a human holding it configures the repo, an
 * agent waits for a human and changes nothing until the request is approved, and enabling is refused
 * where koda cannot broker a GitHub App token (a GitLab repo, or a GitHub repo with no installation).
 *
 * Run: cd apps/api && bun run test:db:up && bun run test:scoped test/integration/fleet/fleet-repo-fix-checks-route.integration.spec.ts
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
const KEY = 'fleet.repo.review.configure';

interface RepoBody { id: string; fixTrustDetectedChecks: boolean }
interface Pending { id: string; permissionKey: string; projectId: string | null }
interface Decided { status: string; result: unknown }

describeIntegration('fleet repo fix-checks route (PG)', () => {
  let app: NathApplication;
  let db: ReturnType<typeof fixtureDb>;
  let world: FleetHttpWorld;
  let agent: Awaited<ReturnType<typeof seedFleetHttpAgent>>;
  let seq = 0;
  const server = () => app.getHttpServer();
  const auth = (token: string) => ({ Authorization: `Bearer ${token}` });
  const patch = (id: string, body: object, token?: string) =>
    request(server()).patch(`/api/fleet/repos/${id}/fix-checks`).set(auth(token ?? world.tokens.root)).send(body);

  /** A fresh repo on the seeded project, so no case reads a row another case wrote. */
  const repo = (over: Record<string, unknown> = {}) => db.fleetRepo.create({
    data: {
      projectId: world.projectId, provider: 'github', owner: 'acme', name: `fix-${++seq}`,
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
    // enabling fix-checks does not ask the caller to be able to dispatch.
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

  it('AC-1: a user holding the key globally enables fix-checks on a GitHub repo', async () => {
    const target = await repo();
    const body = data<RepoBody>(await patch(target.id, { trustDetectedChecks: true }).expect(200));
    expect(body).toMatchObject({ id: target.id, fixTrustDetectedChecks: true });
    expect((await stored(target.id)).fixTrustDetectedChecks).toBe(true);
    // The setting is an audited repo write, under the key the route already asks for.
    expect(await db.auditEntry.findFirst({ where: { key: KEY, resourceId: target.id, summary: 'fix detected checks enabled' } }))
      .toMatchObject({ resourceType: 'fleet-repo', projectId: world.projectId });
  });

  it('AC-2: disabling answers 200 with fixTrustDetectedChecks false and stores it', async () => {
    const target = await repo({ fixTrustDetectedChecks: true });
    const body = data<RepoBody>(await patch(target.id, { trustDetectedChecks: false }).expect(200));
    expect(body).toMatchObject({ id: target.id, fixTrustDetectedChecks: false });
    expect((await stored(target.id)).fixTrustDetectedChecks).toBe(false);
    expect(await db.auditEntry.findFirst({ where: { key: KEY, resourceId: target.id, summary: 'fix detected checks disabled' } }))
      .toMatchObject({ resourceType: 'fleet-repo', projectId: world.projectId });
  });

  it('AC-3: enabling on a GitLab repo answers 422 with the github app reason and stores nothing', async () => {
    const target = await repo({ provider: 'gitlab', githubInstallationId: null });
    const res = await patch(target.id, { trustDetectedChecks: true }).expect(422);
    expect(JSON.stringify(res.body)).toContain('github app required');
    // The refusal is worded by the module's own 422 message, not a bare reason code.
    expect(String(res.body.message)).toContain('Detected checks cannot be trusted: github app required');
    expect((await stored(target.id)).fixTrustDetectedChecks).toBe(false);
  });

  it('AC-4: enabling on a GitHub repo without an installation answers 422 with the github app reason', async () => {
    const target = await repo({ githubInstallationId: null });
    const res = await patch(target.id, { trustDetectedChecks: true }).expect(422);
    expect(String(res.body.message)).toContain('Detected checks cannot be trusted: github app required');
    expect((await stored(target.id)).fixTrustDetectedChecks).toBe(false);
  });

  it('AC-5: disabling on a GitLab repo answers 200 with fixTrustDetectedChecks false', async () => {
    const target = await repo({ provider: 'gitlab', githubInstallationId: null, fixTrustDetectedChecks: true });
    const body = data<RepoBody>(await patch(target.id, { trustDetectedChecks: false }).expect(200));
    expect(body).toMatchObject({ id: target.id, fixTrustDetectedChecks: false });
    expect((await stored(target.id)).fixTrustDetectedChecks).toBe(false);
  });

  it('AC-6: an unknown repo id answers 404 from the repo lookup, not from a missing route', async () => {
    const res = await patch('no-such-repo', { trustDetectedChecks: true }).expect(404);
    // The domain refusal, so a missing route's "Cannot PATCH ..." body does not answer this AC.
    expect(JSON.stringify(res.body)).toContain('Fleet repository not found');
  });

  it.each([
    ['without the field', {}],
    ['with a non-boolean value', { trustDetectedChecks: 'yes' }],
  ])('AC-7: a body %s answers 400 and leaves the row unchanged', async (_label, body) => {
    const target = await repo();
    await patch(target.id, body).expect(400);
    expect((await stored(target.id)).fixTrustDetectedChecks).toBe(false);
    expect(await db.approvalRequest.count()).toBe(0);
  });

  it('AC-8: a user without the global key is refused with 403 and the row is unchanged', async () => {
    const target = await repo();
    await patch(target.id, { trustDetectedChecks: true }, world.tokens.dev).expect(403);
    expect((await stored(target.id)).fixTrustDetectedChecks).toBe(false);
    expect(await db.approvalRequest.count()).toBe(0);
  });

  it('AC-9: an agent with no approval policy waits with 202 and changes nothing', async () => {
    const target = await repo();
    const summary = data<Pending>(await patch(target.id, { trustDetectedChecks: true }, agent.apiKey).expect(202));
    expect(summary).toMatchObject({ permissionKey: KEY, projectId: null });
    expect((await stored(target.id)).fixTrustDetectedChecks).toBe(false);
    expect((await db.approvalRequest.findUniqueOrThrow({ where: { id: summary.id } })).status).toBe('pending');
  });

  it('AC-10: approving that request stores the setting', async () => {
    const target = await repo();
    const summary = data<Pending>(await patch(target.id, { trustDetectedChecks: true }, agent.apiKey).expect(202));
    expect((await approve(summary.id)).status).toBe('executed');
    expect((await stored(target.id)).fixTrustDetectedChecks).toBe(true);
    expect(await db.auditEntry.findFirst({ where: { key: KEY, resourceId: target.id, summary: 'fix detected checks enabled' } }))
      .toMatchObject({ resourceType: 'fleet-repo' });
  });

  it('AC-14: a row created without the setting is listed with fixTrustDetectedChecks false', async () => {
    const created = await repo();
    const enabled = await repo({ fixTrustDetectedChecks: true });
    // The migration default, not a value the fixture wrote.
    expect((await stored(created.id)).fixTrustDetectedChecks).toBe(false);

    const page = data<{ records: RepoBody[] }>(
      await request(server()).get('/api/fleet/repos').set(auth(world.tokens.root)).expect(200),
    );
    expect(page.records.map((record) => record.id)).toEqual(expect.arrayContaining([created.id, enabled.id]));
    expect(page.records.find((record) => record.id === created.id)).toMatchObject({ fixTrustDetectedChecks: false });
    expect(page.records.find((record) => record.id === enabled.id)).toMatchObject({ fixTrustDetectedChecks: true });
  });
});
