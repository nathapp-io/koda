/**
 * Fleet S5b 2b1 US-007 — `koda_record_decision` through the real runner tool route against PG, and the decision it
 * records read back from the memory table after the user approves it.
 *
 * Every call enters at `POST /fleet/runner/jobs/:jobId/tools/<name>?leaseEpoch=<n>` with the real runner key of the
 * runner that holds a RUNNING REPO THREAD job, and the decide enters the real project route
 * `POST /projects/web/fleet/approvals/:approvalId/decide`, so the ACs drive the whole path: runner authentication, the
 * lease fence, the tool registry `MemoryWriteTools` filled at boot, the executor's write-tool branch, the propose
 * service and — on approve — `ExtractionService.recordDecision` for real, which writes the `DECISION` item through
 * `PrismaMemoryItemRepository` as the requester.
 *
 * Each test proposes with its own `toolCallId`, and only the AC that approves writes a decision row.
 *
 * Acceptance setup: project `web` (its key `KODA`), `dev` as its DEVELOPER and the thread creator, `viewer` as its
 * VIEWER, and one RUNNING REPO THREAD job created by `dev` and held by an enrolled runner.
 * FLEET_THREADS_ENABLED=true before boot, or the route answers 409.
 *
 * Run: cd apps/api && bun run test:db:up && bun run test:scoped test/integration/fleet/assistant-record-decision-tool.integration.spec.ts
 */
import request from 'supertest';
import { NathApplication } from '@nathapp/nestjs-app';
import { PrismaService } from '@nathapp/nestjs-prisma';
import type { PrismaClient } from '../../../src/generated/prisma/client';
import { resetDb } from '../../helpers/reset-db';
import { bootHttpApp, data } from '../../helpers/http-app';
import { FleetHttpWorld, enrollRunner, seedFleetHttpWorld } from '../../helpers/fleet-fixtures';
import { seedThreadJobFor, ThreadJobSeed } from '../../helpers/thread-fixtures';

const describeIntegration = process.env.KODA_DB_TESTS === '1' ? describe : describe.skip;
vi.setConfig({ testTimeout: 30_000 });
const ENV = ['FLEET_THREADS_ENABLED'] as const;

/** The web project's key. */
const WEB_KEY = 'KODA';
const TOOL = 'koda_record_decision';
const APPROVALS = '/api/projects/web/fleet/approvals';
/** The decision every AC of this story proposes, and the topic it is recorded under. */
const DECISION = { topic: 'db', decision: 'use postgres', rationale: 'one engine' };
/** What the stored item's object is: the decision and its rationale, one blank line apart (2b1-D7). */
const STORED_OBJECT = 'use postgres\n\nRationale: one engine';
/** The route's answer: `{ content, isError }` data, whatever the status. */
interface ToolResultBody { content: string; isError: boolean }

describeIntegration('fleet assistant record decision tool (PG, US-007)', () => {
  let app: NathApplication;
  let server: ReturnType<NathApplication['getHttpServer']>;
  let prisma: PrismaClient;
  let world: FleetHttpWorld;
  let repo: ThreadJobSeed;
  const saved: Record<string, string | undefined> = {};

  /** POSTs one koda tool call on the held job as its runner, at the job's lease epoch 1. */
  const callTool = (toolCallId: string, body: unknown, job: ThreadJobSeed = repo) =>
    request(server)
      .post(`/api/fleet/runner/jobs/${job.jobId}/tools/${TOOL}?leaseEpoch=1`)
      .set({ Authorization: `Bearer ${job.runnerKey}` })
      .send({ toolCallId, input: body });

  const resultOf = (res: request.Response): ToolResultBody => data<ToolResultBody>(res);

  /** The stored action of one tool call, on the job the call entered through. */
  const actionOf = (toolCallId: string) =>
    prisma.pendingAction.findUniqueOrThrow({ where: { jobId_toolCallId: { jobId: repo.jobId, toolCallId } } });

  /** The active decisions of the topic every AC uses. */
  const storedDecisions = () =>
    prisma.memoryItem.findMany({
      where: { projectId: world.projectId, kind: 'DECISION', predicate: 'db', status: 'active', deletedAt: null },
    });

  /** The one active decision of that topic, or a loud failure. */
  const storedDecision = () =>
    prisma.memoryItem.findFirstOrThrow({
      where: { projectId: world.projectId, kind: 'DECISION', predicate: 'db', status: 'active', deletedAt: null },
    });

  /** One accepted proposal: answers the stored action, asserting the call itself was answered `pending`. */
  const propose = async (toolCallId: string) => {
    const { content, isError } = resultOf(await callTool(toolCallId, DECISION).expect(200));
    expect(isError).toBe(false);
    expect(content.startsWith('pending ')).toBe(true);
    return actionOf(toolCallId);
  };

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
    await prisma.project.update({ where: { id: world.projectId }, data: { key: WEB_KEY } });
    const runner = await enrollRunner(server, world.tokens.root, 'record-decision-runner');
    await prisma.runner.update({
      where: { id: runner.runnerId }, data: { protocolVersion: 4, enabled: true, lastSeenAt: new Date() },
    });
    // `seedThreadJobFor` creates the thread as `dev`: the write tool acts as the thread's requester (2b-R5).
    repo = await seedThreadJobFor(prisma, world, { runnerId: runner.runnerId, apiKey: runner.apiKey }, { feature: 'record-decision' });
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

  it('AC-10: the runner holding dev\'s RUNNING REPO THREAD job proposes one decision and is answered pending', async () => {
    const { content, isError } = resultOf(await callTool('us007-ac10', DECISION).expect(200));

    expect(isError).toBe(false);
    expect(content.startsWith('pending ')).toBe(true);
    const action = await actionOf('us007-ac10');
    expect(action).toMatchObject({ tool: TOOL, status: 'PENDING', requestedById: world.ids.dev });
    expect(content).toBe(`pending ${action.id}: awaiting user approval; do not retry`);
    // The stored preview is the text the user approves: the slug, the quoted topic, the decision and the rationale,
    // with no supersession line, because dev holds no active decision on `db` yet.
    expect(action.preview).toBe('Record a decision in web on "db": use postgres\nRationale: one engine');
    // The audit row proves the call reached the registered tool rather than being refused by name.
    expect(await prisma.assistantToolCall.findUniqueOrThrow({
      where: { jobId_toolCallId: { jobId: repo.jobId, toolCallId: 'us007-ac10' } },
    })).toMatchObject({ tool: TOOL, outcome: 'pending', isError: false });
  });

  it('AC-11: after dev approves, the project holds one active decision recorded as dev, with rationale in the object', async () => {
    const action = await propose('us007-ac11');
    // A proposal writes nothing: the decision exists only once the user decides.
    expect(await storedDecisions()).toEqual([]);

    await decide(action.approvalId, 'approve').expect(200);

    const stored = await storedDecisions();
    expect(stored).toHaveLength(1);
    const item = await storedDecision();
    expect(item).toMatchObject({
      kind: 'DECISION',
      subject: `agent:${world.ids.dev}`,
      predicate: 'db',
      object: STORED_OBJECT,
      ownerId: world.ids.dev,
      sourceType: 'decision_event',
      sourceId: `thread:${repo.threadId}`,
    });
    expect(await prisma.pendingAction.findUniqueOrThrow({ where: { id: action.id } }))
      .toMatchObject({ tool: TOOL, status: 'EXECUTED', result: `decision memory:${item.id} recorded` });
  });
});
