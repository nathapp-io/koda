import { canRunDbTests } from '../../helpers/test-environment';
/**
 * Fleet auto-review K1 part B — the `PATCH /api/fleet/repos/:id/auto-review` route (US-003).
 *
 * The route is a global, approvable write: a human with `fleet.repo.review.configure` runs it and
 * answers the stored repo; an agent under a human-approval policy opens a request and changes
 * nothing until a human approves, after which the settings are stored as the agent's.
 *
 * Run: cd apps/api && bun run test:db:up && bun run test:scoped test/integration/fleet/fleet-repo-auto-review-route.integration.spec.ts
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

interface RepoBody {
  id: string; autoReview: boolean; autoReviewProfiles: string[]; autoReviewMaxCostUsd: string;
  autoReviewEnabledById: string | null; autoReviewEnabledByType: 'USER' | 'AGENT' | null;
  autoReviewEnabledAt: string | null;
}
interface Pending { id: string; permissionKey: string; projectId: string | null }
interface Decided { status: string; result: unknown }

describeIntegration('fleet repo auto-review route (PG)', () => {
  let app: NathApplication;
  let db: ReturnType<typeof fixtureDb>;
  let world: FleetHttpWorld;
  let agent: Awaited<ReturnType<typeof seedFleetHttpAgent>>;
  let seq = 0;
  const server = () => app.getHttpServer();
  const auth = (token: string) => ({ Authorization: `Bearer ${token}` });
  const patch = (id: string, body: unknown, token?: string) =>
    request(server()).patch(`/api/fleet/repos/${id}/auto-review`).set(auth(token ?? world.tokens.root)).send(body);

  /** A fresh GitHub repo on the seeded project, so no case reads a row another case wrote. */
  const repo = (over: Record<string, unknown> = {}) => db.fleetRepo.create({
    data: {
      projectId: world.projectId, provider: 'github', owner: 'acme', name: `review-${++seq}`,
      defaultBranch: 'main', githubInstallationId: BigInt(77), createdById: world.ids.root, ...over,
    },
  });

  /** The policy that makes an agent's auto-review write wait for a human (AC-8). */
  const humanPolicy = () => db.approvalPolicy.create({
    data: {
      selector: `*|${KEY}|type:AGENT`, projectId: null, permissionPattern: KEY, principalType: 'AGENT',
      mode: 'human', updatedByType: 'SYSTEM', updatedById: 'test',
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
    // The agent needs the global route key to reach the handler and dispatch reach in the repo's
    // project, because enabling auto-review is only allowed for a principal that may dispatch there.
    await grantKeys(db, { type: 'AGENT', id: agent.id }, [KEY], null);
    await grantKeys(db, { type: 'AGENT', id: agent.id }, ['fleet.job.dispatch'], world.projectId);
    await app.get(PermissionCache).invalidate();
  }, 90_000);

  afterAll(async () => { await app?.close(); });

  beforeEach(async () => {
    resetThrottle(app);
    await db.approvalDecision.deleteMany();
    await db.approvalRequest.deleteMany();
    await db.approvalPolicy.deleteMany();
  });

  it('AC-1/AC-2: a global admin enables auto-review and is recorded as the enabler', async () => {
    const target = await repo();
    const body = data<RepoBody>(
      await patch(target.id, { enabled: true, profiles: ['native-ds'], maxCostUsd: 2.5 }).expect(200),
    );
    expect(body).toMatchObject({
      id: target.id, autoReview: true, autoReviewProfiles: ['native-ds'], autoReviewMaxCostUsd: '2.5000',
      autoReviewEnabledById: world.ids.root, autoReviewEnabledByType: 'USER',
    });
    expect(body.autoReviewEnabledAt).toEqual(expect.any(String));
    expect(await stored(target.id)).toMatchObject({
      autoReview: true, autoReviewEnabledById: world.ids.root, autoReviewEnabledByType: 'USER',
    });
    // The settings change is an audited repo write, with its own key.
    expect(await db.auditEntry.findFirst({ where: { key: KEY, resourceId: target.id } }))
      .toMatchObject({ resourceType: 'fleet-repo', projectId: world.projectId, summary: 'enabled' });
  });

  it('AC-3: disabling answers autoReview false and clears the enabled timestamp', async () => {
    const target = await repo({
      autoReview: true, autoReviewEnabledById: world.ids.root, autoReviewEnabledByType: 'USER',
      autoReviewEnabledAt: new Date('2026-11-01T00:00:00Z'),
    });
    const body = data<RepoBody>(await patch(target.id, { enabled: false }).expect(200));
    expect(body).toMatchObject({ id: target.id, autoReview: false, autoReviewEnabledAt: null });
    expect(await stored(target.id)).toMatchObject({
      autoReview: false, autoReviewEnabledAt: null, autoReviewEnabledById: null, autoReviewEnabledByType: null,
    });
  });

  it('AC-4: a user without fleet.repo.review.configure is refused with 403', async () => {
    const target = await repo();
    await patch(target.id, { enabled: true }, world.tokens.dev).expect(403);
    expect((await stored(target.id)).autoReview).toBe(false);
    expect(await db.approvalRequest.count()).toBe(0);
  });

  it('AC-5: enabling auto-review on a GitLab repo is 422 with the github app reason', async () => {
    const target = await repo({ provider: 'gitlab', githubInstallationId: null });
    const res = await patch(target.id, { enabled: true }).expect(422);
    expect(JSON.stringify(res.body)).toContain('github app required');
    expect((await stored(target.id)).autoReview).toBe(false);
  });

  it('AC-6: an unknown repo id answers 404 from the repo lookup, not from a missing route', async () => {
    const res = await patch('no-such-repo', { enabled: true }).expect(404);
    // The domain refusal, so a missing route's "Cannot PATCH ..." body does not answer this AC.
    expect(JSON.stringify(res.body)).toContain('Fleet repository not found');
  });

  it('AC-7: a non-boolean enabled answers 400 and stores nothing', async () => {
    const target = await repo();
    await patch(target.id, { enabled: 'yes' }).expect(400);
    expect((await stored(target.id)).autoReview).toBe(false);
  });

  /**
   * An explicit `null` in either optional field must be a validation error, not a 500: `profiles: null`
   * used to reach `[...null]` in the service (TypeError) and `maxCostUsd: null` used to store the string
   * `'null'` in the Decimal column. Both are checked with the switch on and off, because the DTO validates
   * these fields whatever `enabled` is.
   */
  it.each([true, false])('rejects profiles: null with 400 when enabled is %s', async (enabled) => {
    const target = await repo();
    await patch(target.id, { enabled, profiles: null }).expect(400);
    const row = await stored(target.id);
    expect(row.autoReview).toBe(false);
    expect(row.autoReviewProfiles).toEqual([]);
  });

  it.each([true, false])('rejects maxCostUsd: null with 400 when enabled is %s', async (enabled) => {
    const target = await repo();
    await patch(target.id, { enabled, maxCostUsd: null }).expect(400);
    const row = await stored(target.id);
    expect(row.autoReview).toBe(false);
    // The stored default 1.0000 is untouched: nothing was written as the string 'null'.
    expect(Number(row.autoReviewMaxCostUsd)).toBe(1);
  });

  it('AC-8: an agent under a human-approval policy waits with 202 and changes nothing', async () => {
    const target = await repo();
    await humanPolicy();
    const summary = data<Pending>(await patch(target.id, { enabled: true }, agent.apiKey).expect(202));
    expect(summary).toMatchObject({ permissionKey: KEY, projectId: null });
    expect((await stored(target.id)).autoReview).toBe(false);
    expect((await db.approvalRequest.findUniqueOrThrow({ where: { id: summary.id } })).status).toBe('pending');
  });

  it('AC-9: approving that request enables auto-review for the requesting agent', async () => {
    const target = await repo();
    await humanPolicy();
    const summary = data<Pending>(await patch(target.id, { enabled: true }, agent.apiKey).expect(202));
    expect((await approve(summary.id)).status).toBe('executed');
    const row = await stored(target.id);
    expect(row).toMatchObject({
      autoReview: true, autoReviewEnabledByType: 'AGENT', autoReviewEnabledById: agent.id,
    });
    expect(row.autoReviewEnabledAt).not.toBeNull();
  });

  it('AC-10: the repo listing carries autoReviewEnabledAt for every repo', async () => {
    const enabled = await repo({ autoReview: true, autoReviewEnabledAt: new Date('2026-11-01T00:00:00Z') });
    const disabled = await repo();
    const page = data<{ records: RepoBody[] }>(await request(server()).get('/api/fleet/repos').set(auth(world.tokens.root)).expect(200));
    const names = page.records.map((record) => record.id);
    expect(names).toEqual(expect.arrayContaining([enabled.id, disabled.id]));
    expect(page.records.every((record) => Object.hasOwn(record, 'autoReviewEnabledAt'))).toBe(true);
    expect(page.records.find((record) => record.id === enabled.id)?.autoReviewEnabledAt).toBe('2026-11-01T00:00:00.000Z');
    expect(page.records.find((record) => record.id === disabled.id)?.autoReviewEnabledAt).toBeNull();
  });
});
