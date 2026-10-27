import { canRunDbTests } from '../../helpers/test-environment';
/**
 * Permissions P3 US-007 fix round 2 (F4) — the legacy `FleetApproval` rows the fleet accumulated before the asks moved
 * onto the engine are copied onto it at boot, keeping their ids, so the fleet list, get, counts and decide keep serving
 * them instead of losing them.
 *
 * Run: cd apps/api && bun run test:scoped test/integration/fleet/fleet-approval-migration.integration.spec.ts
 */
import request from 'supertest';
import { NathApplication } from '@nathapp/nestjs-app';
import { Prisma, type PrismaClient } from '../../../src/generated/prisma/client';
import { resetDb } from '../../helpers/reset-db';
import { bootHttpApp, data, loginToken, TEST_PASSWORD } from '../../helpers/http-app';
import { FleetHttpWorld, insertRunner, seedFleetHttpWorld } from '../../helpers/fleet-fixtures';
import { LegacyFleetApprovalMigrator } from '../../../src/fleet/approvals/legacy-fleet-approval.migrator';
import { fixtureDb, withTestActor } from '../../helpers/action-context';

const describeIntegration = canRunDbTests() ? describe : describe.skip;
vi.setConfig({ testTimeout: 30_000 });

describeIntegration('legacy fleet approvals migrate onto the engine (PG)', () => {
  let app: NathApplication;
  let prisma: PrismaClient;
  let world: FleetHttpWorld;
  let migrator: LegacyFleetApprovalMigrator;
  let runnerId: string;
  let padmin: string;
  let padminId: string;
  let n = 0;
  const as = (token: string) => ({ Authorization: `Bearer ${token}` });
  /** The boot hook runs the copy as `seed` (the context every boot seeder uses); the test does the same. */
  const migrate = () => withTestActor({ type: 'SYSTEM', id: 'seed' }, () => migrator.migrateAll());
  const PROJECT = '/api/projects/web/fleet/approvals';

  const job = (over: Partial<Prisma.FleetJobUncheckedCreateInput> = {}) => prisma.fleetJob.create({
    data: {
      projectId: world.projectId, repoId: world.repoId, ref: 'main', command: 'RUN', feature: `mig${++n}`, profiles: [],
      maxCostUsd: new Prisma.Decimal(5), selectorLabels: [], requestedById: world.ids.dev, requestedByType: 'USER',
      state: 'RUNNING', runnerId, leaseEpoch: 1, bashMode: 'escalate', firstStartedAt: new Date(), ...over,
    },
  });
  const legacyBash = async (over: Partial<Prisma.FleetApprovalUncheckedCreateInput> = {}) => {
    const running = await job();
    const naxAskId = `legacy-ask-${++n}`;
    const row = await prisma.fleetApproval.create({
      data: {
        type: 'nax_bash_escalate', projectId: world.projectId, jobId: running.id, leaseEpoch: running.leaseEpoch, naxAskId,
        payload: { command: 'bun run test', commandTruncated: false, options: ['allow', 'deny'] },
        requestedAt: new Date(), expiresAt: null, ...over,
      },
    });
    return { job: running, row };
  };

  beforeAll(async () => {
    await resetDb();
    app = await bootHttpApp({ registrationEnabled: false });
    prisma = fixtureDb(app);
    world = await seedFleetHttpWorld(app.getHttpServer(), prisma);
    migrator = app.get(LegacyFleetApprovalMigrator);
    runnerId = (await insertRunner(prisma, { createdById: world.ids.root })).id;
    await request(app.getHttpServer()).post('/api/admin/users').set(as(world.tokens.root))
      .send({ email: 'mig-admin@koda.test', name: 'mig admin', password: TEST_PASSWORD, role: 'MEMBER' }).expect(201);
    await request(app.getHttpServer()).post('/api/projects/web/members').set(as(world.tokens.root))
      .send({ email: 'mig-admin@koda.test', roleKey: 'project-admin' }).expect(201);
    padmin = await loginToken(app.getHttpServer(), 'mig-admin@koda.test');
    padminId = (await prisma.user.findUniqueOrThrow({ where: { email: 'mig-admin@koda.test' } })).id;
  });
  afterAll(async () => { await app.close(); });
  beforeEach(async () => {
    await prisma.fleetApprovalAsk.deleteMany();
    await prisma.approvalRequest.deleteMany();
    await prisma.fleetApproval.deleteMany();
    await prisma.fleetCommand.deleteMany();
    await prisma.fleetJob.deleteMany();
    await prisma.outboxEvent.deleteMany();
  });

  it('copies a pending legacy bash ask with its id, so the fleet list, get and counts serve it', async () => {
    const { row } = await legacyBash();

    expect(await migrate()).toBe(1);

    const migrated = await prisma.approvalRequest.findUniqueOrThrow({ where: { id: row.id } });
    expect(migrated).toMatchObject({
      id: row.id, permissionKey: 'fleet.job.shell.escalate', status: 'pending', projectId: world.projectId,
      actorType: 'SYSTEM', actorId: 'runner', onBehalfOfType: 'USER', onBehalfOfId: world.ids.dev, origin: 'runner',
    });
    const link = await prisma.fleetApprovalAsk.findUniqueOrThrow({ where: { requestId: row.id } });
    expect(link).toMatchObject({ kind: 'bash', jobId: row.jobId, leaseEpoch: row.leaseEpoch, naxAskId: row.naxAskId, budgetPolicyId: null });

    const page = data<{ records: Array<{ id: string }> }>(await request(app.getHttpServer()).get(PROJECT).set(as(world.tokens.dev)).expect(200));
    expect(page.records.map((a) => a.id)).toEqual([row.id]);
    const one = data<{ status: string; jobId: string }>(await request(app.getHttpServer()).get(`${PROJECT}/${row.id}`).set(as(world.tokens.dev)).expect(200));
    expect(one).toEqual(expect.objectContaining({ status: 'pending', jobId: row.jobId }));
    const counts = data<{ total: number }>(await request(app.getHttpServer()).get('/api/fleet/approval-counts').set(as(world.tokens.dev)).expect(200));
    expect(counts.total).toBe(1);
  });

  it('F4 (fix round 3): an old pending legacy ask stays decidable — it never expired before the migration', async () => {
    // Three days old and no expiry of its own: a migration that dated the expiry from its creation would hand the
    // engine an already-expired ask, and every decide would answer 409.
    const requestedAt = new Date(Date.now() - 3 * 86_400_000);
    const { row } = await legacyBash({ requestedAt, createdAt: requestedAt });

    await migrate();

    const migrated = await prisma.approvalRequest.findUniqueOrThrow({ where: { id: row.id } });
    expect(migrated.status).toBe('pending');
    expect(migrated.expiresAt.getTime()).toBeGreaterThan(Date.now());
    await request(app.getHttpServer()).post(`${PROJECT}/${row.id}/decide`).set(as(padmin)).send({ decision: 'deny' }).expect(200);
  });

  it('F4 (fix round 3): the copy is one transaction, and a row left without its link is finished on the next pass', async () => {
    const { job: running, row } = await legacyBash();
    // The state an interrupted earlier attempt leaves: the request is there, its link is not.
    await withTestActor({ type: 'SYSTEM', id: 'seed' }, () => migrator.migrateAll());
    await prisma.fleetApprovalAsk.delete({ where: { requestId: row.id } });
    // A second legacy row, so the pass has to progress past the half-migrated one.
    const second = await legacyBash();

    expect(await migrate()).toBe(2);

    expect(await prisma.approvalRequest.count({ where: { id: { in: [row.id, second.row.id] } } })).toBe(2);
    expect(await prisma.fleetApprovalAsk.count({ where: { requestId: { in: [row.id, second.row.id] } } })).toBe(2);
    // The requester lookup still resolved the job, and no second decision row appeared for the finished ask.
    expect(await prisma.fleetCommand.count({ where: { jobId: running.id } })).toBe(0);
  });

  it('F4 (fix round 3): the timed pass drains a batch the boot pass left behind', async () => {
    await legacyBash();
    await legacyBash();

    // One row per batch, as a small batch size would copy.
    expect(await withTestActor({ type: 'SYSTEM', id: 'seed' }, () => migrator.migrateBatch(1))).toBe(1);
    expect(await prisma.fleetApprovalAsk.count()).toBe(1);
    // The continuation (the timer runs this same pass) finishes the rest without a restart.
    expect(await migrate()).toBe(1);
    expect(await prisma.fleetApprovalAsk.count()).toBe(2);
  });

  it('builds the frozen input and hash, so a migrated pending ask is decidable and executes', async () => {
    const { job: running, row } = await legacyBash();
    await migrate();

    await request(app.getHttpServer()).post(`${PROJECT}/${row.id}/decide`).set(as(padmin)).send({ decision: 'allow' }).expect(200);

    expect((await prisma.approvalRequest.findUniqueOrThrow({ where: { id: row.id } })).status).toBe('executed');
    const command = await prisma.fleetCommand.findFirstOrThrow({ where: { jobId: running.id, type: 'APPROVAL_ANSWER' } });
    expect(command.payload).toEqual(expect.objectContaining({ approvalId: row.id, naxAskId: row.naxAskId, choice: 'allow' }));
    expect((await prisma.approvalRequest.findMany({ where: { id: row.id }, include: { decisions: true } }))[0].decisions)
      .toMatchObject([{ deciderId: padminId, decision: 'approve' }]);
  });

  it('keeps a decided legacy ask decided, with its decision, and never copies it twice', async () => {
    const policy = await prisma.budgetPolicy.create({ data: {
      scopeType: 'project', scopeId: world.projectId, scopeKey: `project:${world.projectId}`, projectId: world.projectId,
      windowKind: 'calendar_month_utc', amountUsd: new Prisma.Decimal(10), warnPercent: null,
      createdById: world.ids.root, updatedById: world.ids.root,
    } });
    const row = await prisma.fleetApproval.create({ data: {
      type: 'budget_override_required', projectId: world.projectId, policyId: policy.id, requestedAt: new Date(),
      payload: { scopeType: 'project', scopeId: world.projectId, windowKind: 'calendar_month_utc', windowStart: new Date().toISOString(), spentUsd: '10', amountUsd: '10' },
      status: 'approved', decision: 'raise_budget_and_resume', decidedById: padminId, decidedAt: new Date(),
      outcome: { resumedAmountUsd: '20', requeueResults: [] },
    } });

    expect(await migrate()).toBe(1);
    expect(await migrate()).toBe(0);
    expect(await prisma.approvalRequest.count({ where: { id: row.id } })).toBe(1);

    const view = data<{ status: string; decision: string; decidedById: string; outcome: Record<string, unknown> }>(
      await request(app.getHttpServer()).get(`${PROJECT}/${row.id}`).set(as(world.tokens.dev)).expect(200));
    expect(view).toEqual(expect.objectContaining({
      status: 'approved', decision: 'raise_budget_and_resume', decidedById: padminId,
      outcome: { resumedAmountUsd: '20', requeueResults: [] },
    }));
  });
});
