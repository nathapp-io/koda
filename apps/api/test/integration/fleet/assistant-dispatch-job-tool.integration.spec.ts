import { findThreadAction } from '../../helpers/assistant-request';
import { grantKeys } from '../../../src/approvals/test-helpers/approval-fixtures';
import { canRunDbTests } from '../../helpers/test-environment';
/**
 * Fleet S5b 2b2 US-003 — `koda_dispatch_job` through the real runner tool route against PG.
 *
 * Every call enters at `POST /fleet/runner/jobs/:jobId/tools/koda_dispatch_job?leaseEpoch=<n>` with the real runner
 * key of the runner that holds a RUNNING THREAD job, and every decide enters the real project route
 * `POST /projects/web/fleet/approvals/:approvalId/decisions`, so the ACs drive the whole path: runner authentication,
 * the lease fence, the tool registry `FleetWriteTools` filled at boot, the executor's write-tool branch, the propose
 * service and — on approve — `FleetJobsService.dispatch` for real.
 *
 * Acceptance setup: project `web` with the GitHub repository `acme/app` (default branch `trunk`), the foreign project
 * `ops` holding `acme/ops`, `dev` as web's DEVELOPER and the thread creator, and one RUNNING REPO THREAD job held by
 * an enrolled runner. FLEET_THREADS_ENABLED=true before boot, or the route answers 409. Each test proposes with its
 * own tool call id and its own feature, so it reads only what it wrote.
 *
 * Run: cd apps/api && bun run test:db:up && bun run test:scoped test/integration/fleet/assistant-dispatch-job-tool.integration.spec.ts
 */
import request from 'supertest';
import { NathApplication } from '@nathapp/nestjs-app';
import type { PrismaClient } from '../../../src/generated/prisma/client';
import { resetDb } from '../../helpers/reset-db';
import { bootHttpApp, data } from '../../helpers/http-app';
import { FleetHttpWorld, enrollRunner, seedFleetHttpWorld } from '../../helpers/fleet-fixtures';
import { seedThreadJobFor, ThreadJobSeed } from '../../helpers/thread-fixtures';
import { expectGuardActive, fixtureDb } from '../../helpers/action-context';

// The nax sandbox withholds host Postgres/Docker.
const describeIntegration = canRunDbTests() ? describe : describe.skip;
vi.setConfig({ testTimeout: 30_000 });
const ENV = ['FLEET_THREADS_ENABLED'] as const;

const TOOL = 'koda_dispatch_job';
const APPROVALS = '/api/approvals';
/** The nax feature name this test dispatches; no other spec uses it (`.nax/rules/api-test-isolation.md`). */
const FEATURE = 'dispatch-tool-us003';
/** The route's answer: `{ content, isError }` data, whatever the status. */
interface ToolResultBody { content: string; isError: boolean }

describeIntegration('fleet assistant dispatch job tool (PG, US-003)', () => {
  let app: NathApplication;
  let server: ReturnType<NathApplication['getHttpServer']>;
  let prisma: PrismaClient;
  let world: FleetHttpWorld;
  let runnerKey: string;
  let repo: ThreadJobSeed;
  const saved: Record<string, string | undefined> = {};

  /** POSTs one `koda_dispatch_job` call on the held job as its runner, at the job's lease epoch 1. */
  const callTool = (toolCallId: string, input: unknown) =>
    request(server)
      .post(`/api/fleet/runner/jobs/${repo.jobId}/tools/${TOOL}?leaseEpoch=1`)
      .set({ Authorization: `Bearer ${runnerKey}` })
      .send({ toolCallId, input });

  const resultOf = (res: request.Response): ToolResultBody => data<ToolResultBody>(res);

  const actionOf = (toolCallId: string) =>
    findThreadAction(prisma, { jobId: repo.jobId, toolCallId });

  /** The dispatched job of this test's feature, or null while no dispatch happened. */
  const jobWith = (feature: string) =>
    prisma.fleetJob.findFirst({ where: { projectId: world.projectId, feature }, select: { id: true, command: true, maxCostUsd: true, ref: true, repoId: true, requestedById: true } });

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
    const runner = await enrollRunner(server, world.tokens.root, 'dispatch-job-runner');
    await prisma.runner.update({
      where: { id: runner.runnerId }, data: { protocolVersion: 4, enabled: true, lastSeenAt: new Date() },
    });
    runnerKey = runner.apiKey;
    repo = await seedThreadJobFor(prisma, world, { runnerId: runner.runnerId, apiKey: runner.apiKey }, { feature: 'dispatch-tool' });
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

  it('AC-13 + AC-14: the call proposes, and dev\'s approval dispatches a RUN job as dev', async () => {
    const { content, isError } = resultOf(await callTool('ac13', {
      repo: 'acme/app', command: 'RUN', feature: FEATURE, maxCostUsd: 0.5,
    }).expect(200));

    expect({ isError, pending: content.startsWith('pending ') }).toEqual({ isError: false, pending: true });
    // The stored preview is the masked proposal the user approves: the repository line carries the default branch
    // because the input named no ref.
    const action = await actionOf('ac13');
    expect(action.tool).toBe(TOOL);
    expect(action.preview.split('\n')).toEqual([
      'Dispatch RUN in web:',
      'repo: acme/app @ trunk',
      `feature: ${FEATURE}`,
      'max cost: $0.5',
    ]);
    // The proposal waits: no job exists before the user decides.
    expect(await jobWith(FEATURE)).toBeNull();

    await decide(action.id, 'approve').expect(200);

    const job = await jobWith(FEATURE);
    expect(job).toMatchObject({
      requestedById: world.ids.dev, command: 'RUN', ref: 'trunk', repoId: world.repoId,
    });
    expect(job?.maxCostUsd.toString()).toBe('0.5');
    // The action's result is what `execute` answered: the job it dispatched and the path a human can open. The state
    // is whatever placement left the job in, so only the shape is pinned.
    expect(((await findThreadAction(prisma, { requestId: action.id })).result as { text: string }).text)
      .toMatch(new RegExp(`^dispatched ${job?.id as string}: [A-Z]+ /web/fleet/jobs/${job?.id as string}$`));
  });

  it('AC-15: the foreign project\'s repository answers not_found and stores no action', async () => {
    const { content, isError } = resultOf(await callTool('ac15', {
      repo: 'acme/ops', command: 'RUN', feature: FEATURE, maxCostUsd: 0.5,
    }).expect(200));

    expect({ content, isError }).toEqual({ content: 'not_found', isError: true });
    expect(await prisma.assistantActionRequest.count({ where: { jobId: repo.jobId, toolCallId: 'ac15' } })).toBe(0);
    // The audit row proves the call reached the registered tool rather than being refused by name.
    expect(await prisma.assistantToolCall.findUniqueOrThrow({ where: { jobId_toolCallId: { jobId: repo.jobId, toolCallId: 'ac15' } } }))
      .toMatchObject({ tool: TOOL, outcome: 'not_found', isError: true, content: 'not_found' });
  });

  /**
   * The same path with the optional fields on: a PLAN whose repository resolves inside the project dispatches on
   * `acme/app` and writes nothing into the foreign project `ops`.
   */
  it('a PLAN with a plan path dispatches on the project\'s own repository and never on the foreign one', async () => {
    const { content } = resultOf(await callTool('ac-extra', {
      repo: 'acme/app', command: 'PLAN', feature: 'dispatch-tool-us003-second', maxCostUsd: 1.25, planFrom: 'docs/spec.md',
    }).expect(200));
    expect(content.startsWith('pending ')).toBe(true);

    const action = await actionOf('ac-extra');
    await decide(action.id, 'approve').expect(200);

    const job = await jobWith('dispatch-tool-us003-second');
    expect(job).toMatchObject({ requestedById: world.ids.dev, command: 'PLAN', repoId: world.repoId });
    expect(await prisma.fleetJob.count({ where: { projectId: world.opsProjectId } })).toBe(0);
  });
});
