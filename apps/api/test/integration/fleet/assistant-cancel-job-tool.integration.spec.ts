/**
 * Fleet S5b 2b2 US-005 — `koda_cancel_job` through the real runner tool route against PG.
 *
 * Every call enters at `POST /fleet/runner/jobs/:jobId/tools/koda_cancel_job?leaseEpoch=<n>` with the real runner
 * key of the runner that holds a RUNNING THREAD job, and every decide enters the real project route
 * `POST /projects/web/fleet/approvals/:approvalId/decide`, so the ACs drive the whole path: runner authentication,
 * the lease fence, the tool registry `FleetWriteTools` filled at boot, the executor's write-tool branch, the propose
 * service and — on approve — `FleetJobsService.cancel` for real.
 *
 * Acceptance setup: project `web` with the GitHub repository `acme/app` (default branch `trunk`), the foreign project
 * `ops` holding `acme/ops`, `dev` as web's DEVELOPER and the thread creator, and one RUNNING REPO THREAD job held by
 * an enrolled runner. FLEET_THREADS_ENABLED=true before boot, or the route answers 409.
 *
 * Each test creates the RUN job it acts on itself, in the state it needs, on `acme/app` and with a feature no other
 * test uses, so it reads only what it wrote and the file passes in any order (`.nax/rules/api-test-isolation.md`). The
 * job the approved test cancels carries `selectorLabels: ['no-such-label']`: nothing places a job this file writes —
 * the fixture runner never syncs — but the labels keep it QUEUED even if something ever did, so the cancel always
 * runs down the server-side path and the job is CANCELLED the moment `dev` approves.
 *
 * Run: cd apps/api && bun run test:db:up && bun run test:scoped test/integration/fleet/assistant-cancel-job-tool.integration.spec.ts
 */
import request from 'supertest';
import { NathApplication } from '@nathapp/nestjs-app';
import { PrismaService } from '@nathapp/nestjs-prisma';
import { Prisma, type PrismaClient } from '../../../src/generated/prisma/client';
import { resetDb } from '../../helpers/reset-db';
import { bootHttpApp, data } from '../../helpers/http-app';
import { FleetHttpWorld, enrollRunner, seedFleetHttpWorld } from '../../helpers/fleet-fixtures';
import { seedThreadJobFor, ThreadJobSeed } from '../../helpers/thread-fixtures';

const describeIntegration = process.env.KODA_DB_TESTS === '1' ? describe : describe.skip;
vi.setConfig({ testTimeout: 30_000 });
const ENV = ['FLEET_THREADS_ENABLED'] as const;

const TOOL = 'koda_cancel_job';
const APPROVALS = '/api/projects/web/fleet/approvals';
/** The route's answer: `{ content, isError }` data, whatever the status. */
interface ToolResultBody { content: string; isError: boolean }

describeIntegration('fleet assistant cancel job tool (PG, US-005)', () => {
  let app: NathApplication;
  let server: ReturnType<NathApplication['getHttpServer']>;
  let prisma: PrismaClient;
  let world: FleetHttpWorld;
  let runnerKey: string;
  let repo: ThreadJobSeed;
  const saved: Record<string, string | undefined> = {};

  /** POSTs one `koda_cancel_job` call on the held job as its runner, at the job's lease epoch 1. */
  const callTool = (toolCallId: string, input: unknown) =>
    request(server)
      .post(`/api/fleet/runner/jobs/${repo.jobId}/tools/${TOOL}?leaseEpoch=1`)
      .set({ Authorization: `Bearer ${runnerKey}` })
      .send({ toolCallId, input });

  const resultOf = (res: request.Response): ToolResultBody => data<ToolResultBody>(res);

  const actionOf = (toolCallId: string) =>
    prisma.pendingAction.findUniqueOrThrow({ where: { jobId_toolCallId: { jobId: repo.jobId, toolCallId } } });

  /**
   * The RUN job this test acts on, written straight into PG the way `seedThreadJobFor` writes the THREAD job. Only
   * the columns the cancel reads are set: the state it is cancelled from, the labels that keep it QUEUED, and dev as
   * the requester.
   */
  const seedRunJob = async (over: { feature: string; state: string; selectorLabels?: string[]; projectId?: string; repoId?: string }): Promise<string> =>
    (await prisma.fleetJob.create({
      data: {
        projectId: over.projectId ?? world.projectId, repoId: over.repoId ?? world.repoId, ref: 'trunk', command: 'RUN',
        feature: over.feature, profiles: [], selectorLabels: over.selectorLabels ?? [],
        maxCostUsd: new Prisma.Decimal(0.5), requestedById: world.ids.dev, state: over.state,
        ...(['QUEUED', 'ASSIGNED', 'RUNNING', 'UPLOADING'].includes(over.state) ? {} : { finishedAt: new Date() }),
      },
      select: { id: true },
    })).id;

  /** The job's own row, as the ACs compare it. */
  const jobState = (jobId: string) =>
    prisma.fleetJob.findUniqueOrThrow({ where: { id: jobId }, select: { state: true, feature: true, selectorLabels: true } });

  /** `dev` decides one approval; answers the decide response. */
  const decide = (approvalId: string, decision: string) =>
    request(server).post(`${APPROVALS}/${approvalId}/decide`).set({ Authorization: `Bearer ${world.tokens.dev}` }).send({ decision });

  beforeAll(async () => {
    saved['FLEET_THREADS_ENABLED'] = process.env['FLEET_THREADS_ENABLED'];
    process.env['FLEET_THREADS_ENABLED'] = 'true';
    await resetDb();
    app = await bootHttpApp({ registrationEnabled: false });
    server = app.getHttpServer();
    prisma = app.get<PrismaService<PrismaClient>>(PrismaService).client;
    world = await seedFleetHttpWorld(server, prisma);
    const runner = await enrollRunner(server, world.tokens.root, 'cancel-job-runner');
    await prisma.runner.update({
      where: { id: runner.runnerId }, data: { protocolVersion: 4, enabled: true, lastSeenAt: new Date() },
    });
    runnerKey = runner.apiKey;
    repo = await seedThreadJobFor(prisma, world, { runnerId: runner.runnerId, apiKey: runner.apiKey }, { feature: 'cancel-tool' });
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

  it('AC-10 + AC-11: the call proposes one QUEUED job, and dev\'s approval cancels it', async () => {
    const jobId = await seedRunJob({ feature: 'cancel-tool-us005', state: 'QUEUED', selectorLabels: ['no-such-label'] });

    const { content, isError } = resultOf(await callTool('ac10', { jobId }).expect(200));

    expect({ isError, pending: content.startsWith('pending ') }).toEqual({ isError: false, pending: true });
    // The stored preview is the masked proposal the user approves: the job, as it is right now — still QUEUED — and
    // the repository it runs on, named owner/name.
    const action = await actionOf('ac10');
    expect(action.tool).toBe(TOOL);
    expect(action.preview.split('\n')).toEqual([
      'Cancel job ' + jobId + ' in web:',
      'RUN cancel-tool-us005 on acme/app @ trunk, now QUEUED',
    ]);
    // The proposal waits: the job is still the one the test wrote before the user decides.
    expect((await jobState(jobId)).state).toBe('QUEUED');

    await decide(action.approvalId, 'approve').expect(200);

    // 2b2-D6: the cancel really ran — a QUEUED job is cancelled server-side, so it is CANCELLED straight away and the
    // action's result is the cancelled form, not the request form.
    expect(await jobState(jobId)).toMatchObject({ state: 'CANCELLED', selectorLabels: ['no-such-label'] });
    expect(await prisma.pendingAction.findUniqueOrThrow({ where: { id: action.id } }))
      .toMatchObject({ status: 'EXECUTED', result: `cancelled ${jobId} /web/fleet/jobs/${jobId}` });
  });

  it('AC-12: cancelling the runner\'s own THREAD job answers invalid_input: command and stores no action', async () => {
    const { content, isError } = resultOf(await callTool('ac12', { jobId: repo.jobId }).expect(200));

    expect({ content, isError }).toEqual({ content: 'invalid_input: command', isError: true });
    expect(await prisma.pendingAction.count({ where: { jobId: repo.jobId, toolCallId: 'ac12' } })).toBe(0);
    // The thread's own job is untouched: a THREAD session ends through end-session, never through this tool (2b2-R5).
    expect((await jobState(repo.jobId)).state).toBe('RUNNING');
    // The audit row proves the call reached the registered tool rather than being refused by name.
    expect(await prisma.assistantToolCall.findUniqueOrThrow({ where: { jobId_toolCallId: { jobId: repo.jobId, toolCallId: 'ac12' } } }))
      .toMatchObject({ tool: TOOL, outcome: 'invalid_input', isError: true, content: 'invalid_input: command' });
  });

  it('a terminal job answers invalid_input: state and stores no action', async () => {
    const jobId = await seedRunJob({ feature: 'cancel-tool-us005-completed', state: 'COMPLETED' });

    const { content, isError } = resultOf(await callTool('ac-state', { jobId }).expect(200));

    expect({ content, isError }).toEqual({ content: 'invalid_input: state', isError: true });
    expect(await prisma.pendingAction.count({ where: { jobId: repo.jobId, toolCallId: 'ac-state' } })).toBe(0);
    expect((await jobState(jobId)).state).toBe('COMPLETED');
  });

  it('a job of another project answers not_found and stores no action', async () => {
    const foreignJobId = await seedRunJob({
      feature: 'cancel-tool-us005-foreign', state: 'QUEUED', projectId: world.opsProjectId, repoId: world.foreignRepoId,
    });

    const { content, isError } = resultOf(await callTool('ac-foreign', { jobId: foreignJobId }).expect(200));

    expect({ content, isError }).toEqual({ content: 'not_found', isError: true });
    expect(await prisma.pendingAction.count({ where: { jobId: repo.jobId, toolCallId: 'ac-foreign' } })).toBe(0);
    expect((await jobState(foreignJobId)).state).toBe('QUEUED');
  });
});
