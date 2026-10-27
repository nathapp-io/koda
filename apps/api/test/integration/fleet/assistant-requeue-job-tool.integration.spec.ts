import { findThreadAction } from '../../helpers/assistant-request';
import { grantKeys } from '../../../src/approvals/test-helpers/approval-fixtures';
import { canRunDbTests } from '../../helpers/test-environment';
/**
 * Fleet S5b 2b2 US-004 — `koda_requeue_job` through the real runner tool route against PG.
 *
 * Every call enters at `POST /fleet/runner/jobs/:jobId/tools/koda_requeue_job?leaseEpoch=<n>` with the real runner
 * key of the runner that holds a RUNNING THREAD job, and every decide enters the real project route
 * `POST /projects/web/fleet/approvals/:approvalId/decisions`, so the ACs drive the whole path: runner authentication,
 * the lease fence, the tool registry `FleetWriteTools` filled at boot, the executor's write-tool branch, the propose
 * service and — on approve — `FleetJobsService.requeue` for real.
 *
 * Acceptance setup: project `web` with the GitHub repository `acme/app` (default branch `trunk`), the foreign project
 * `ops` holding `acme/ops`, `dev` as web's DEVELOPER and the thread creator, and one RUNNING REPO THREAD job held by
 * an enrolled runner. FLEET_THREADS_ENABLED=true before boot, or the route answers 409.
 *
 * Each test creates the RUN job it acts on itself, in the state it needs, on `acme/app` and with a feature no other
 * test uses, so it reads only what it wrote and the file passes in any order (`.nax/rules/api-test-isolation.md`). The
 * job the approved test requeues carries `selectorLabels: ['no-such-label']`: the requeue keeps the labels, placement
 * reports a `labels` misfit against the fixture runner, and the job stays QUEUED instead of taking the runner's one
 * slot.
 *
 * Run: cd apps/api && bun run test:db:up && bun run test:scoped test/integration/fleet/assistant-requeue-job-tool.integration.spec.ts
 */
import request from 'supertest';
import { NathApplication } from '@nathapp/nestjs-app';
import { Prisma, type PrismaClient } from '../../../src/generated/prisma/client';
import { resetDb } from '../../helpers/reset-db';
import { bootHttpApp, data } from '../../helpers/http-app';
import { FleetHttpWorld, enrollRunner, seedFleetHttpWorld } from '../../helpers/fleet-fixtures';
import { seedThreadJobFor, ThreadJobSeed } from '../../helpers/thread-fixtures';
import { expectGuardActive, fixtureDb } from '../../helpers/action-context';

// The nax sandbox withholds host Postgres/Docker.
const describeIntegration = canRunDbTests() ? describe : describe.skip;
vi.setConfig({ testTimeout: 30_000 });
const ENV = ['FLEET_THREADS_ENABLED'] as const;

const TOOL = 'koda_requeue_job';
const APPROVALS = '/api/approvals';
/** The route's answer: `{ content, isError }` data, whatever the status. */
interface ToolResultBody { content: string; isError: boolean }

describeIntegration('fleet assistant requeue job tool (PG, US-004)', () => {
  let app: NathApplication;
  let server: ReturnType<NathApplication['getHttpServer']>;
  let prisma: PrismaClient;
  let world: FleetHttpWorld;
  let runnerKey: string;
  let repo: ThreadJobSeed;
  const saved: Record<string, string | undefined> = {};

  /** POSTs one `koda_requeue_job` call on the held job as its runner, at the job's lease epoch 1. */
  const callTool = (toolCallId: string, input: unknown) =>
    request(server)
      .post(`/api/fleet/runner/jobs/${repo.jobId}/tools/${TOOL}?leaseEpoch=1`)
      .set({ Authorization: `Bearer ${runnerKey}` })
      .send({ toolCallId, input });

  const resultOf = (res: request.Response): ToolResultBody => data<ToolResultBody>(res);

  const actionOf = (toolCallId: string) =>
    findThreadAction(prisma, { jobId: repo.jobId, toolCallId });

  /**
   * The RUN job this test acts on, written straight into PG the way `seedThreadJobFor` writes the THREAD job. Only
   * the columns the requeue reads are set: the state it is requeued from, the labels that keep it QUEUED, and dev as
   * the requester.
   */
  const seedRunJob = async (over: { feature: string; state: string; selectorLabels?: string[]; projectId?: string; repoId?: string }): Promise<string> =>
    (await prisma.fleetJob.create({
      data: {
        projectId: over.projectId ?? world.projectId, repoId: over.repoId ?? world.repoId, ref: 'trunk', command: 'RUN',
        feature: over.feature, profiles: [], selectorLabels: over.selectorLabels ?? [],
        maxCostUsd: new Prisma.Decimal(0.5), requestedById: world.ids.dev, state: over.state,
        ...(over.state === 'FAILED' ? { finishedAt: new Date() } : {}),
      },
      select: { id: true },
    })).id;

  /** The job's own row, as the ACs compare it. */
  const jobState = (jobId: string) =>
    prisma.fleetJob.findUniqueOrThrow({ where: { id: jobId }, select: { state: true, feature: true, selectorLabels: true } });

  /** `dev` decides one approval; answers the decide response. */
  const decide = (approvalId: string, decision: string) =>
    request(server).post(`${APPROVALS}/${approvalId}/decisions`).set({ Authorization: `Bearer ${world.tokens.dev}` }).send({ decision });

  beforeAll(async () => {
    saved['FLEET_THREADS_ENABLED'] = process.env['FLEET_THREADS_ENABLED'];
    process.env['FLEET_THREADS_ENABLED'] = 'true';
    await resetDb();
    app = await bootHttpApp({ registrationEnabled: false });
    server = app.getHttpServer();
    prisma = fixtureDb(app);
    world = await seedFleetHttpWorld(server, prisma);
    await grantKeys(prisma, { type: 'USER', id: world.ids.dev }, ['approval.decide'], world.projectId);
    const runner = await enrollRunner(server, world.tokens.root, 'requeue-job-runner');
    await prisma.runner.update({
      where: { id: runner.runnerId }, data: { protocolVersion: 4, enabled: true, lastSeenAt: new Date() },
    });
    runnerKey = runner.apiKey;
    repo = await seedThreadJobFor(prisma, world, { runnerId: runner.runnerId, apiKey: runner.apiKey }, { feature: 'requeue-tool' });
  }, 120_000);

  afterAll(async () => {
    try {
      await app?.close();
    } finally {
      for (const key of ENV) {
        if (saved[key] === undefined) delete process.env[key];
        else process.env[key] = saved[key];
      }
    }
  });

  it('writes need an action context', async () => {
    await expect(expectGuardActive(app)).resolves.toBeUndefined();
  });

  it('AC-12 + AC-13: the call proposes one FAILED job, and dev\'s approval requeues it', async () => {
    const jobId = await seedRunJob({ feature: 'requeue-tool-us004', state: 'FAILED', selectorLabels: ['no-such-label'] });

    const { content, isError } = resultOf(await callTool('ac12', { jobId }).expect(200));

    expect({ isError, pending: content.startsWith('pending ') }).toEqual({ isError: false, pending: true });
    // The stored preview is the masked proposal the user approves: the job, as it is right now — still FAILED — and
    // the repository it will run on again, named owner/name.
    const action = await actionOf('ac12');
    expect(action.tool).toBe(TOOL);
    expect(action.preview.split('\n')).toEqual([
      'Requeue job ' + jobId + ' in web:',
      'RUN requeue-tool-us004 on acme/app @ trunk, now FAILED',
      'max cost: $0.5',
    ]);
    // The proposal waits: the job is still the one the test wrote before the user decides.
    expect((await jobState(jobId)).state).toBe('FAILED');

    await decide(action.id, 'approve').expect(200);

    // 2b2-D6: the requeue really ran — the job is back in QUEUED with the labels it was created with, and it is the
    // labels misfit (not a placement) that keeps it there rather than on the fixture runner.
    expect(await jobState(jobId)).toMatchObject({ state: 'QUEUED', selectorLabels: ['no-such-label'] });
    expect(await findThreadAction(prisma, { requestId: action.id }))
      .toMatchObject({ status: 'executed', result: { text: `requeued ${jobId}: QUEUED /web/fleet/jobs/${jobId}` } });
  });

  it('AC-14: a RUNNING job answers invalid_input: state and stores no action', async () => {
    const jobId = await seedRunJob({ feature: 'requeue-tool-us004-running', state: 'RUNNING' });

    const { content, isError } = resultOf(await callTool('ac14', { jobId }).expect(200));

    expect({ content, isError }).toEqual({ content: 'invalid_input: state: the job is RUNNING; only a FAILED, CRASHED or CANCELLED job can be requeued', isError: true });
    expect(await prisma.assistantActionRequest.count({ where: { jobId: repo.jobId, toolCallId: 'ac14' } })).toBe(0);
    expect((await jobState(jobId)).state).toBe('RUNNING');
    // The audit row proves the call reached the registered tool rather than being refused by name.
    expect(await prisma.assistantToolCall.findUniqueOrThrow({ where: { jobId_toolCallId: { jobId: repo.jobId, toolCallId: 'ac14' } } }))
      .toMatchObject({ tool: TOOL, outcome: 'invalid_input', isError: true, content: 'invalid_input: state: the job is RUNNING; only a FAILED, CRASHED or CANCELLED job can be requeued' });
  });

  it('a job of another project answers not_found and stores no action', async () => {
    const foreignJobId = await seedRunJob({
      feature: 'requeue-tool-us004-foreign', state: 'FAILED', projectId: world.opsProjectId, repoId: world.foreignRepoId,
    });

    const { content, isError } = resultOf(await callTool('ac-foreign', { jobId: foreignJobId }).expect(200));

    expect({ content, isError }).toEqual({ content: 'not_found', isError: true });
    expect(await prisma.assistantActionRequest.count({ where: { jobId: repo.jobId, toolCallId: 'ac-foreign' } })).toBe(0);
    expect((await jobState(foreignJobId)).state).toBe('FAILED');
  });
});
