import { canRunDbTests } from '../../helpers/test-environment';
/**
 * Fleet #370 (C11) US-008 — the per-repo rule override at assignment (PG): the override is read when the
 * job is assigned, travels with the ASSIGN of a nax job, and the job records the summary of what it was
 * assigned. A THREAD turn and a config job never carry one, and a job assigned after the override was
 * cleared carries none either.
 *
 * Run: cd apps/api && bun run test:db:up && bun run test:scoped test/integration/fleet/placement-rule-override.integration.spec.ts
 */
import request from 'supertest';
import type { NathApplication } from '@nathapp/nestjs-app';
import { Prisma, PrismaClient } from '../../../src/generated/prisma/client';
import { resetDb } from '../../helpers/reset-db';
import { bootHttpApp, data } from '../../helpers/http-app';
import { enrollRunner, FLEET_CAPS, FleetHttpWorld, seedFleetHttpWorld, syncBody } from '../../helpers/fleet-fixtures';
import { grantKeys } from '../../../src/approvals/test-helpers/approval-fixtures';
import { PermissionCache } from '../../../src/permissions/permission-cache';
import { ruleOverrideSha256, validateRuleOverride } from '../../../src/fleet/repos/rule-override';
import { PrismaFleetJobRepository } from '../../../src/fleet/jobs/prisma-fleet-job.repository';
import type { AssignPayload, FleetCommandOut, RunnerCapabilities, SyncResponse } from '../../../src/fleet/common/protocol';
import { fixtureDb } from '../../helpers/action-context';

// The nax sandbox withholds host Postgres/Docker.
const describeIntegration = canRunDbTests() ? describe : describe.skip;
vi.setConfig({ testTimeout: 30_000 });

const RULES = [
  { path: 'api.md', content: 'always answer with the summary' },
  { path: 'ci.md', content: 'run the checks before the review' },
];
const CONTEXT = { content: 'the project answers in english', mode: 'append' as const };
const BODY = { rules: RULES, rulesMode: 'merge' as const, context: CONTEXT };
const SHA = ruleOverrideSha256(validateRuleOverride(BODY));

/** A runner whose lastSeenAt predates any placement window: offline for every test that does not enroll one. */
const OFFLINE_AT = new Date('2020-01-01T00:00:00.000Z');

/** The FLEET_CAPS report plus the thread capabilities a v4 runner advertises. */
const threadCaps = (over: Partial<RunnerCapabilities> = {}): RunnerCapabilities => ({
  ...FLEET_CAPS,
  threadBackends: { native: ['m1'], acp: [] },
  threadWrite: true,
  ...over,
});

interface JobBody { id: string; state: string; ruleOverride?: { sha256: string; ruleFiles: number; rulesMode: string; contextMode: string | null } | null }

describeIntegration('fleet job rule override at assignment (PG, US-008)', () => {
  let app: NathApplication;
  let server: ReturnType<NathApplication['getHttpServer']>;
  let prisma: PrismaClient;
  let world: FleetHttpWorld;
  let runner: { runnerId: string; apiKey: string };
  let jobs: PrismaFleetJobRepository;
  let seq = 0;
  const saved: Record<string, string | undefined> = {};

  const auth = (token: string) => ({ Authorization: `Bearer ${token}` });
  const asDev = () => auth(world.tokens.dev);
  const asRoot = () => auth(world.tokens.root);

  /** A fresh repo on the seeded project, so no case reads a row another case wrote. */
  const repo = (over: Record<string, unknown> = {}) => prisma.fleetRepo.create({
    data: {
      projectId: world.projectId, provider: 'github', owner: 'acme', name: `rules-${++seq}`,
      defaultBranch: 'main', githubInstallationId: BigInt(77), createdById: world.ids.root, ...over,
    },
  });

  const putOverride = (repoId: string, body: unknown) =>
    request(server).put(`/api/fleet/repos/${repoId}/rule-override`).set(asRoot()).send(body as object);
  const clearOverride = (repoId: string) =>
    request(server).delete(`/api/fleet/repos/${repoId}/rule-override`).set(asRoot());

  const dispatch = async (body: object) => data<{ job: { id: string; state: string } }>(
    await request(server).post('/api/projects/web/fleet/jobs').set(asDev()).send(body).expect(201),
  );
  const dispatchRun = (repoId: string, feature: string) =>
    dispatch({ command: 'RUN', repoId, feature, maxCostUsd: 1 });

  const sync = async (over: Partial<Parameters<typeof syncBody>[0]> = {}) => data<SyncResponse>(
    await request(server).post('/api/fleet/runner/sync').set(auth(runner.apiKey)).send(syncBody(over)).expect(200),
  );

  /** The ASSIGN commands of one job, oldest first. */
  const assignFor = (jobId: string) => prisma.fleetCommand.findMany({ where: { jobId, type: 'ASSIGN' }, orderBy: { createdAt: 'asc' } });
  const assignPayload = async (jobId: string): Promise<AssignPayload> => {
    const commands = await assignFor(jobId);
    expect(commands).toHaveLength(1);
    return commands[0].payload as AssignPayload;
  };
  /** The ASSIGN a runner was handed for a job in a sync answer. */
  const assignOf = (res: SyncResponse, jobId: string): FleetCommandOut => {
    const command = res.commands.find((c) => c.type === 'ASSIGN' && c.jobId === jobId);
    if (!command) throw new Error(`no ASSIGN for job ${jobId}`);
    return command;
  };
  const jobRow = (jobId: string) => prisma.fleetJob.findUniqueOrThrow({ where: { id: jobId } });
  const jobDetail = async (jobId: string) => data<JobBody>(
    await request(server).get(`/api/projects/web/fleet/jobs/${jobId}`).set(asDev()).expect(200),
  );

  beforeAll(async () => {
    for (const key of ['FLEET_SYNC_WAIT_MS', 'FLEET_THREADS_ENABLED']) saved[key] = process.env[key];
    process.env['FLEET_SYNC_WAIT_MS'] = '0';
    process.env['FLEET_THREADS_ENABLED'] = 'true';
    await resetDb();
    app = await bootHttpApp({ registrationEnabled: false });
    server = app.getHttpServer();
    prisma = fixtureDb(app);
    world = await seedFleetHttpWorld(server, prisma);
    jobs = app.get(PrismaFleetJobRepository);
    // The rule-override writes are gated by their own global key, so it is granted here.
    await grantKeys(prisma, { type: 'USER', id: world.ids.root }, ['fleet.repo.rules.configure'], null);
    await app.get(PermissionCache).invalidate();
    runner = await enrollRunner(server, world.tokens.root, 'rule-override-runner', { capabilities: FLEET_CAPS });
  }, 60_000);

  afterAll(async () => {
    try {
      await app?.close();
    } finally {
      for (const [key, value] of Object.entries(saved)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  });

  beforeEach(async () => {
    await prisma.fleetCommand.deleteMany();
    await prisma.fleetJob.deleteMany();
    // Only the one runner of this file is online, so a placement has exactly one candidate.
    await prisma.runner.updateMany({ data: { lastSeenAt: OFFLINE_AT } });
    await prisma.runner.update({ where: { id: runner.runnerId }, data: { lastSeenAt: new Date(), capacity: 4 } });
  });

  it('AC-5: a RUN on a repo with an override carries it in the ASSIGN', async () => {
    const target = await repo();
    await putOverride(target.id, BODY).expect(200);

    const result = await dispatchRun(target.id, 'ac5');
    expect(result.job.state).toBe('ASSIGNED');

    const payload = await assignPayload(result.job.id);
    expect(payload.ruleOverride).toEqual({ sha256: SHA, rulesMode: 'merge', rules: RULES, context: CONTEXT });
  });

  it('AC-6: the job row records the summary of the override it was assigned', async () => {
    const target = await repo();
    await putOverride(target.id, BODY).expect(200);

    const result = await dispatchRun(target.id, 'ac6');

    expect((await jobRow(result.job.id)).ruleOverride).toEqual({ sha256: SHA, ruleFiles: 2, rulesMode: 'merge', contextMode: 'append' });
  });

  it('AC-7: the job detail reports the same rule override summary', async () => {
    const target = await repo();
    await putOverride(target.id, BODY).expect(200);

    const result = await dispatchRun(target.id, 'ac7');

    expect((await jobDetail(result.job.id)).ruleOverride).toEqual({ sha256: SHA, ruleFiles: 2, rulesMode: 'merge', contextMode: 'append' });
  });

  it('AC-8: a RUN on a repo without an override carries no override and records none', async () => {
    const target = await repo();

    const result = await dispatchRun(target.id, 'ac8');

    const payload = await assignPayload(result.job.id);
    expect(payload).not.toHaveProperty('ruleOverride');
    expect((await jobRow(result.job.id)).ruleOverride).toBeNull();
    expect((await jobDetail(result.job.id)).ruleOverride).toBeNull();
  });

  it('AC-9: a job queued while the runner was full and assigned after the override was cleared carries none', async () => {
    await prisma.runner.update({ where: { id: runner.runnerId }, data: { capacity: 1 } });
    const busyRepo = await repo({ name: `busy-${++seq}` });
    await prisma.fleetJob.create({ data: {
      projectId: world.projectId, repoId: busyRepo.id, ref: 'main', command: 'RUN', feature: 'occupy-slot', profiles: [],
      maxCostUsd: new Prisma.Decimal(1), selectorLabels: [], requestedById: world.ids.dev, state: 'RUNNING',
      runnerId: runner.runnerId, runnerBootId: 'boot-1', leaseEpoch: 1, assignedAt: new Date(), startedAt: new Date(),
    } });
    const target = await repo();
    await putOverride(target.id, BODY).expect(200);

    const result = await dispatchRun(target.id, 'ac9');
    expect(result.job.state).toBe('QUEUED');
    expect(await assignFor(result.job.id)).toHaveLength(0);

    // The override is turned off while the job waits: the job is assigned after the change.
    await clearOverride(target.id).expect(200);
    await prisma.fleetJob.updateMany({ where: { repoId: busyRepo.id }, data: { state: 'COMPLETED' } });
    const response = await sync({ freeSlots: 1 });

    expect(response.commands.filter((command) => command.type === 'ASSIGN' && command.jobId === result.job.id)).toHaveLength(1);
    const payload = await assignPayload(result.job.id);
    expect(payload).not.toHaveProperty('ruleOverride');
    expect((await jobRow(result.job.id)).ruleOverride).toBeNull();
  });

  it('AC-10: a THREAD turn on a repo with an override carries no override', async () => {
    const target = await repo();
    await putOverride(target.id, BODY).expect(200);
    const threadRunner = await enrollRunner(server, world.tokens.root, `thread-runner-${++seq}`, { capabilities: threadCaps() });
    // Only the thread runner is online for this case.
    await prisma.runner.update({ where: { id: runner.runnerId }, data: { lastSeenAt: OFFLINE_AT } });

    const threadId = data<{ id: string }>(await request(server).post('/api/projects/web/threads').set(asDev())
      .send({ repoId: target.id, feature: 'ac10-thread', title: 'Rule override thread', backend: { kind: 'native', model: 'm1' } }).expect(201)).id;
    await request(server).post(`/api/projects/web/threads/${threadId}/messages`).set(asDev())
      .send({ text: 'Which tickets are blocked?', clientMessageId: `cm-${++seq}` }).expect(201);
    const job = await prisma.fleetJob.findFirstOrThrow({ where: { threadId, command: 'THREAD' }, orderBy: { queuedAt: 'desc' } });

    const response = data<SyncResponse>(await request(server).post('/api/fleet/runner/sync').set(auth(threadRunner.apiKey))
      .send(syncBody({ protocolVersion: 4, bootId: 'boot-1', freeSlots: 1, capabilities: threadCaps() })).expect(200));

    const assign = assignOf(response, job.id);
    expect(assign.payload).not.toHaveProperty('ruleOverride');
    expect((await jobRow(job.id)).ruleOverride).toBeNull();
  });

  it('AC-11: findRuleOverride maps a stored row to the wire shape', async () => {
    const target = await repo();
    await putOverride(target.id, BODY).expect(200);

    expect(await jobs.findRuleOverride(target.id)).toEqual({ sha256: SHA, rulesMode: 'merge', rules: RULES, context: CONTEXT });
  });

  it('AC-12: findRuleOverride omits the context of a row without one', async () => {
    const target = await repo();
    await putOverride(target.id, { rules: RULES }).expect(200);

    const override = await jobs.findRuleOverride(target.id);
    expect(override).toEqual({ sha256: ruleOverrideSha256(validateRuleOverride({ rules: RULES })), rulesMode: 'merge', rules: RULES });
    expect(override).not.toHaveProperty('context');
  });

  it('AC-13: findRuleOverride answers null for a repo without an override', async () => {
    const target = await repo();

    expect(await jobs.findRuleOverride(target.id)).toBeNull();
  });

  it('AC-14: a job assigned with an override still reports it when an older runner dropped the field', async () => {
    const target = await repo();
    await putOverride(target.id, BODY).expect(200);
    const result = await dispatchRun(target.id, 'ac14');

    // The runner picks the ASSIGN up, drops the field it does not know and starts the job.
    const response = await sync({ freeSlots: 1 });
    const assign = assignOf(response, result.job.id);
    const { ruleOverride: _dropped, ...olderRunnerView } = assign.payload as Record<string, unknown>;
    expect(olderRunnerView).not.toHaveProperty('ruleOverride');
    await sync({
      commandAcks: [{ commandId: assign.commandId, leaseEpoch: assign.leaseEpoch, result: 'ok' }],
      jobs: [{ jobId: result.job.id, leaseEpoch: assign.leaseEpoch, events: [{ seq: 1, type: 'state', payload: { to: 'RUNNING' } }] }],
    });

    expect((await jobDetail(result.job.id)).ruleOverride).toEqual({ sha256: SHA, ruleFiles: 2, rulesMode: 'merge', contextMode: 'append' });
  });
});
