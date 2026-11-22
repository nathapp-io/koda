import { canRunDbTests } from '../../helpers/test-environment';
/**
 * US-005 (ACP probe) — the operator's re-probe request over HTTP on PG: the gated route, its audit
 * entry, the atomic consumption by the next sync, and the concurrent take.
 * Run: cd apps/api && bun run test:scoped test/integration/fleet/runner-reprobe.integration.spec.ts
 */
import request from 'supertest';
import { NathApplication } from '@nathapp/nestjs-app';
import { PrismaClient } from '../../../src/generated/prisma/client';
import { resetDb } from '../../helpers/reset-db';
import { bootHttpApp, data } from '../../helpers/http-app';
import { enrollRunner, FleetHttpWorld, insertRunner, seedFleetHttpAgent, seedFleetHttpWorld, syncBody } from '../../helpers/fleet-fixtures';
import { asTestActor, fixtureDb } from '../../helpers/action-context';
import { grantKeys } from '../../../src/approvals/test-helpers/approval-fixtures';
import { PermissionCache } from '../../../src/permissions/permission-cache';
import { PrismaFleetJobRepository } from '../../../src/fleet/jobs/prisma-fleet-job.repository';
import type { SyncResponse } from '../../../src/fleet/common/protocol';

// The nax sandbox withholds host Postgres/Docker.
const describeIntegration = canRunDbTests() ? describe : describe.skip;

describeIntegration('runner re-probe request (PG)', () => {
  let app: NathApplication;
  let server: ReturnType<NathApplication['getHttpServer']>;
  let prisma: PrismaClient;
  let world: FleetHttpWorld;
  let runner: { runnerId: string; apiKey: string };
  const saved = process.env.FLEET_SYNC_WAIT_MS;

  const auth = (token: string) => ({ Authorization: `Bearer ${token}` });
  /** The route takes no body; `{}` keeps the JSON content type the API expects. */
  const reprobe = (id: string, token?: string) =>
    request(server).post(`/api/fleet/runners/${id}/reprobe`).set(auth(token ?? world.tokens.root)).send({});
  const sync = async () =>
    data<SyncResponse>(await request(server).post('/api/fleet/runner/sync').set(auth(runner.apiKey)).send(syncBody()).expect(200));
  const storedRequest = async () =>
    (await prisma.runner.findUniqueOrThrow({ where: { id: runner.runnerId }, select: { reprobeRequestedAt: true } })).reprobeRequestedAt;

  beforeAll(async () => {
    // No long poll: a sync answers at once, so the re-probe is delivered in this very response.
    process.env.FLEET_SYNC_WAIT_MS = '0';
    await resetDb();
    app = await bootHttpApp({ registrationEnabled: false });
    server = app.getHttpServer();
    prisma = fixtureDb(app);
    world = await seedFleetHttpWorld(server, prisma);
    runner = await enrollRunner(server, world.tokens.root, 'box-1');
  });
  afterAll(async () => {
    await app.close();
    if (saved === undefined) delete process.env.FLEET_SYNC_WAIT_MS;
    else process.env.FLEET_SYNC_WAIT_MS = saved;
  });

  it('AC-1: a global admin requests a re-probe and the runner row carries the same ISO time', async () => {
    const res = await reprobe(runner.runnerId).expect(200);
    const { requestedAt } = data<{ requestedAt: string }>(res);
    expect(requestedAt).toEqual(expect.any(String));
    expect(Number.isNaN(Date.parse(requestedAt))).toBe(false);
    expect(new Date(requestedAt).toISOString()).toBe(requestedAt);
    expect((await storedRequest())?.toISOString()).toBe(requestedAt);
  });

  it('AC-2: an unknown runner id answers 404', async () => {
    const res = await reprobe('no-such-runner').expect(404);
    // The route's own refusal, not "no such route": the message is the fleet.runners 404 text.
    expect(JSON.stringify(res.body)).toContain('Runner not found');
  });

  it('AC-3: a user without fleet.runner.update is refused and the row stays null', async () => {
    await prisma.runner.update({ where: { id: runner.runnerId }, data: { reprobeRequestedAt: null } });
    await reprobe(runner.runnerId, world.tokens.dev).expect(403);
    expect(await storedRequest()).toBeNull();
  });

  it('AC-4: the next sync answers reprobe: true and clears the request', async () => {
    await reprobe(runner.runnerId).expect(200);
    expect(await storedRequest()).not.toBeNull();
    expect((await sync()).reprobe).toBe(true);
    expect(await storedRequest()).toBeNull();
  });

  it('AC-5: after that one delivery the body of the next sync has no reprobe key', async () => {
    await reprobe(runner.runnerId).expect(200);
    expect((await sync()).reprobe).toBe(true);
    const next = await sync();
    expect(Object.prototype.hasOwnProperty.call(next, 'reprobe')).toBe(false);
  });

  it('AC-6: a successful request leaves exactly one fleet.runner.update audit row for the runner', async () => {
    const before = await prisma.auditEntry.count({ where: { key: 'fleet.runner.update', resourceId: runner.runnerId } });
    await reprobe(runner.runnerId).expect(200);
    const entries = await prisma.auditEntry.findMany({ where: { key: 'fleet.runner.update', resourceId: runner.runnerId } });
    expect(entries).toHaveLength(before + 1);
    expect(entries[0]).toMatchObject({
      key: 'fleet.runner.update', resourceType: 'fleet-runner', resourceId: runner.runnerId, projectId: null, summary: 'reprobe requested',
    });
    // The row the API wrote is the one the operator asked for: one request, one entry.
    expect((await storedRequest())).not.toBeNull();
  });

  it('US-005: an approval policy answers 202 and the approved request stamps the row', async () => {
    // A distinct approver is required, so the requester is an agent that holds the key globally and the
    // decider is root. This is the policy path AC-1 deliberately runs without.
    const agent = await seedFleetHttpAgent(server, world.tokens.root);
    await grantKeys(prisma, { type: 'AGENT', id: agent.id }, ['fleet.runner.update'], null);
    await app.get(PermissionCache).invalidate();
    const policy = await prisma.approvalPolicy.create({ data: {
      selector: '*|fleet.runner.update|any', projectId: null, permissionPattern: 'fleet.runner.update',
      principalType: null, mode: 'agent', updatedByType: 'SYSTEM', updatedById: 'test',
    } });
    try {
      await prisma.runner.update({ where: { id: runner.runnerId }, data: { reprobeRequestedAt: null } });
      const summary = data<{ id: string; permissionKey: string }>(await reprobe(runner.runnerId, agent.apiKey).expect(202));
      expect(summary.permissionKey).toBe('fleet.runner.update');
      // Nothing was written while the request waits.
      expect(await storedRequest()).toBeNull();

      // Approving runs the registered reprobe command: the variant the controller named is the one the
      // engine executes, so an unregistered variant would fail here.
      const decided = data<{ status: string }>(
        await request(server).post(`/api/approvals/${summary.id}/decisions`).set(auth(world.tokens.root)).send({ decision: 'approve' }).expect(200),
      );
      expect(decided.status).toBe('executed');
      expect(await storedRequest()).not.toBeNull();
    } finally {
      await prisma.approvalPolicy.delete({ where: { id: policy.id } });
    }
  });

  it('AC-13: two concurrent takes of one pending request resolve exactly one true and one false', async () => {
    // The repository writes through PrismaService, so its calls need the principal an entry point gives them.
    const jobs = asTestActor(app.get(PrismaFleetJobRepository, { strict: false }), { type: 'USER', id: world.ids.root });
    const target = await insertRunner(prisma);
    await prisma.runner.update({ where: { id: target.id }, data: { reprobeRequestedAt: new Date() } });
    expect(await jobs.hasPendingReprobe(target.id)).toBe(true);

    const results = await Promise.all([jobs.takeReprobeRequest(target.id), jobs.takeReprobeRequest(target.id)]);
    expect(results.filter((result) => result === true)).toHaveLength(1);
    expect(results.filter((result) => result === false)).toHaveLength(1);
    expect(await jobs.hasPendingReprobe(target.id)).toBe(false);
    expect(await jobs.takeReprobeRequest(target.id)).toBe(false);
  });
});
