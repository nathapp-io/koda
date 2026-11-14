import { canRunDbTests } from '../../helpers/test-environment';
import { NathApplication } from '@nathapp/nestjs-app';
import type { PrismaClient } from '../../../src/generated/prisma/client';
import { FleetFlowAdvanceService } from '../../../src/fleet/flows/fleet-flow-advance.service';
import { FleetFlowsService } from '../../../src/fleet/flows/fleet-flows.service';
import { fixtureDb, withTestActor } from '../../helpers/action-context';
import { runAsSystem } from '../../../src/action-context/action-context';
import { insertRunner, seedFleetBase } from '../../helpers/fleet-fixtures';
import { bootHttpApp } from '../../helpers/http-app';
import { resetDb } from '../../helpers/reset-db';

const integration = canRunDbTests() ? describe : describe.skip;
const SHA = 'a'.repeat(40);
const SPEC = '.nax/features/flow/spec.md';

integration('fleet flow failure stop', () => {
  let app: NathApplication;
  let db: PrismaClient;
  let engine: FleetFlowAdvanceService;
  let flows: FleetFlowsService;
  let projectId: string;
  let repoId: string;
  let creatorId: string;
  let runnerId: string;
  let threadId: string;
  const now = new Date('2026-11-07T12:00:00.000Z');

  beforeAll(async () => {
    vi.stubEnv('FLEET_THREADS_ENABLED', 'true');
    await resetDb();
    app = await bootHttpApp({ registrationEnabled: false });
    db = fixtureDb(app);
    ({ projectId, repoId, adminId: creatorId } = await seedFleetBase(db));
    runnerId = (await insertRunner(db, { name: `failure-flow-${Date.now()}`, createdById: creatorId })).id;
    const thread = await db.chatThread.create({ data: {
      projectId, repoId, title: 'failure stop', createdById: creatorId,
      backend: { kind: 'native', model: 'm1' }, skills: [], feature: 'flow', specPath: SPEC,
      baseRef: 'main', runnerId, publishedSha: SHA, specPublished: true, writtenPaths: [SPEC],
    } });
    threadId = thread.id;
    await db.chatThread.update({ where: { id: threadId }, data: {
      preApproval: { userId: creatorId, at: now.toISOString(), costCapUsd: '30' },
    } });
    engine = app.get(FleetFlowAdvanceService);
    flows = app.get(FleetFlowsService);
  }, 60_000);

  afterAll(async () => { try { await app?.close(); } finally { vi.unstubAllEnvs(); } });

  beforeEach(async () => {
    await db.fleetFlowFeature.deleteMany();
    await db.fleetFlow.deleteMany();
  });

  async function createFlow(features = ['flow']) {
    return withTestActor({ type: 'USER', id: creatorId }, async () => (await flows.create({
      entry: 'THREAD', threadId,
      features: features.map((feature) => ({ feature, specPath: SPEC, dependsOn: [] })),
      roles: { reviewer: 'acp:claude', supervisor: 'native:fast' }, costCapUsd: '25',
    }, { type: 'USER', id: creatorId }, { projectId, now })).flow);
  }

  it('AC-1/2/3/8: locks and audits a RUNNING stop and normalizes empty detail', async () => {
    const flow = await createFlow();
    await db.fleetFlow.update({ where: { id: flow.id }, data: { state: 'RUNNING' } });
    expect(await runAsSystem('flow', () => engine.stopFailedFlow(flow.id, 'boom', now), { onBehalfOf: { type: 'USER', id: creatorId } })).toBe(true);
    expect(await db.fleetFlow.findUniqueOrThrow({ where: { id: flow.id } })).toMatchObject({
      state: 'STOPPED', stopReason: 'internal_error', stopDetail: 'boom',
    });
    expect(await db.fleetActivity.count({ where: { entityType: 'flow', entityId: flow.id, action: 'flow.stopped' } })).toBe(1);
    const empty = await createFlow();
    await db.fleetFlow.update({ where: { id: empty.id }, data: { state: 'RUNNING' } });
    expect(await runAsSystem('flow', () => engine.stopFailedFlow(empty.id, '', now), { onBehalfOf: { type: 'USER', id: creatorId } })).toBe(true);
    expect((await db.fleetFlow.findUniqueOrThrow({ where: { id: empty.id } })).stopDetail).toBe('internal error');
  });

  it('AC-4: stops a WAITING_MERGE flow through the locked decision path', async () => {
    const flow = await createFlow();
    await db.fleetFlow.update({ where: { id: flow.id }, data: { state: 'WAITING_MERGE' } });
    expect(await runAsSystem('flow', () => engine.stopFailedFlow(flow.id, 'merge failure', now), { onBehalfOf: { type: 'USER', id: creatorId } })).toBe(true);
    expect(await db.fleetFlow.findUniqueOrThrow({ where: { id: flow.id } })).toMatchObject({ state: 'STOPPED', stopReason: 'internal_error' });
  });

  it('AC-5/10: returns false without changing a stopped or missing flow', async () => {
    const flow = await createFlow();
    await db.fleetFlow.update({ where: { id: flow.id }, data: { state: 'STOPPED', stopReason: 'step_failed', endedAt: now } });
    const before = await db.fleetFlow.findUniqueOrThrow({ where: { id: flow.id } });
    expect(await engine.stopFailedFlow(flow.id, 'ignored', new Date(now.getTime() + 1_000))).toBe(false);
    const after = await db.fleetFlow.findUniqueOrThrow({ where: { id: flow.id } });
    expect(after).toMatchObject({ stopReason: before.stopReason, endedAt: before.endedAt });
    expect(await engine.stopFailedFlow('missing-flow', 'ignored', now)).toBe(false);
  });
});
