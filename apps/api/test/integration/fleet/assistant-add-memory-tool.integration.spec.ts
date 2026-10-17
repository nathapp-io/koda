/**
 * Fleet S5b 2b1 US-006 — `koda_add_memory` through the real runner tool route against PG, and the item it stores read
 * back through `koda_memory_search` at the same route.
 *
 * Every call enters at `POST /fleet/runner/jobs/:jobId/tools/<name>?leaseEpoch=<n>` with the real runner key of the
 * runner that holds a RUNNING REPO THREAD job, and every decide enters the real project route
 * `POST /projects/web/fleet/approvals/:approvalId/decide`, so the ACs drive the whole path: runner authentication,
 * the lease fence, the tool registry `MemoryWriteTools` filled at boot, the executor's write-tool branch, the propose
 * service and — on approve — `PrismaMemoryItemRepository.upsert` for real, whose row `koda_memory_search` then reads.
 * Each test proposes with its own `toolCallId`, and only the AC that approves writes a row.
 *
 * Acceptance setup: project `web` (its key `KODA`), `dev` as its DEVELOPER and the thread creator, `viewer` as its
 * VIEWER, and one RUNNING REPO THREAD job created by `dev` and held by an enrolled runner.
 * FLEET_THREADS_ENABLED=true before boot, or the route answers 409.
 *
 * Run: cd apps/api && bun run test:db:up && bun run test:scoped test/integration/fleet/assistant-add-memory-tool.integration.spec.ts
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
const TOOL = 'koda_add_memory';
const SEARCH_TOOL = 'koda_memory_search';
const APPROVALS = '/api/projects/web/fleet/approvals';
/** The item every AC of this story proposes: `bun` is the word the search reads it back by. */
const ITEM = { kind: 'FACT', subject: 'api', predicate: 'runs on', object: 'bun' };
/** The route's answer: `{ content, isError }` data, whatever the status. */
interface ToolResultBody { content: string; isError: boolean }

describeIntegration('fleet assistant add memory tool (PG, US-006)', () => {
  let app: NathApplication;
  let server: ReturnType<NathApplication['getHttpServer']>;
  let prisma: PrismaClient;
  let world: FleetHttpWorld;
  let repo: ThreadJobSeed;
  const saved: Record<string, string | undefined> = {};

  /** POSTs one koda tool call on the held job as its runner, at the job's lease epoch 1. */
  const callTool = (toolCallId: string, body: unknown, name: string = TOOL, job: ThreadJobSeed = repo) =>
    request(server)
      .post(`/api/fleet/runner/jobs/${job.jobId}/tools/${name}?leaseEpoch=1`)
      .set({ Authorization: `Bearer ${job.runnerKey}` })
      .send({ toolCallId, input: body });

  const resultOf = (res: request.Response): ToolResultBody => data<ToolResultBody>(res);

  /** The stored action of one tool call, on the job the call entered through. */
  const actionOf = (toolCallId: string) =>
    prisma.pendingAction.findUniqueOrThrow({ where: { jobId_toolCallId: { jobId: repo.jobId, toolCallId } } });

  /** The active items of the key every AC uses. */
  const storedItems = () =>
    prisma.memoryItem.findMany({
      where: { projectId: world.projectId, kind: 'FACT', subject: 'api', predicate: 'runs on', status: 'active', deletedAt: null },
    });

  /** The one active item of that key, or a loud failure. */
  const storedItem = () =>
    prisma.memoryItem.findFirstOrThrow({
      where: { projectId: world.projectId, kind: 'FACT', subject: 'api', predicate: 'runs on', status: 'active', deletedAt: null },
    });

  /** One accepted proposal: answers the stored action, asserting the call itself was answered `pending`. */
  const propose = async (toolCallId: string, item: unknown = ITEM) => {
    const { content, isError } = resultOf(await callTool(toolCallId, item).expect(200));
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
    const runner = await enrollRunner(server, world.tokens.root, 'add-memory-runner');
    await prisma.runner.update({
      where: { id: runner.runnerId }, data: { protocolVersion: 4, enabled: true, lastSeenAt: new Date() },
    });
    // `seedThreadJobFor` creates the thread as `dev`: the write tool acts as the thread's requester (2b-R5).
    repo = await seedThreadJobFor(prisma, world, { runnerId: runner.runnerId, apiKey: runner.apiKey }, { feature: 'add-memory' });
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

  /**
   * Branch review M1: every test starts from a clean version of the key it shares, so an assertion that the key is
   * empty or that its preview has no replacement line does not depend on whether the approving test already ran.
   */
  beforeEach(async () => {
    await prisma.memoryItem.deleteMany({
      where: { projectId: world.projectId, kind: 'FACT', subject: 'api', predicate: 'runs on' },
    });
  });

  it('AC-10: the runner holding dev\'s RUNNING REPO THREAD job proposes one memory and is answered pending', async () => {
    const { content, isError } = resultOf(await callTool('ac10', ITEM).expect(200));

    expect(isError).toBe(false);
    expect(content.startsWith('pending ')).toBe(true);
    const action = await actionOf('ac10');
    expect(action).toMatchObject({ tool: TOOL, status: 'PENDING', requestedById: world.ids.dev });
    expect(content).toBe(`pending ${action.id}: awaiting user approval; do not retry`);
    // The stored preview is the text the user approves: the project slug, the key and the object, no replacement line.
    expect(action.preview).toBe('Remember in web: FACT api / runs on\nbun');
    // The audit row proves the call reached the registered tool rather than being refused by name.
    expect(await prisma.assistantToolCall.findUniqueOrThrow({
      where: { jobId_toolCallId: { jobId: repo.jobId, toolCallId: 'ac10' } },
    })).toMatchObject({ tool: TOOL, outcome: 'pending', isError: false });
  });

  it('AC-11: the proposal writes no memory item, so the key has no active item while the user decides', async () => {
    const action = await propose('ac11');

    expect(await storedItems()).toEqual([]);
    expect(action).toMatchObject({ status: 'PENDING' });
    // The preview saw no active item of that key: it carries no replacement line.
    expect(action.preview.split('\n')).toEqual(['Remember in web: FACT api / runs on', 'bun']);
  });

  it('AC-12: after dev approves, koda_memory_search answers the memory:<id> of the stored item', async () => {
    const action = await propose('ac12');

    await decide(action.approvalId, 'approve').expect(200);

    const stored = await storedItems();
    expect(stored).toHaveLength(1);
    const item = await storedItem();
    expect(item).toMatchObject({
      kind: 'FACT', subject: 'api', predicate: 'runs on', object: 'bun',
      sourceType: 'thread', sourceId: repo.threadId, confidence: 0.8, ownerId: world.ids.dev,
    });
    expect(await prisma.pendingAction.findUniqueOrThrow({ where: { id: action.id } }))
      .toMatchObject({ status: 'EXECUTED', result: `memory:${item.id} saved` });

    const { content, isError } = resultOf(await callTool('ac12-search', { text: 'bun' }, SEARCH_TOOL).expect(200));

    expect(isError).toBe(false);
    expect(content).toContain(`memory:${item.id}`);
  });
});
