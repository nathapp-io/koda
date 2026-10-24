import { canRunDbTests } from '../../helpers/test-environment';
/**
 * Fleet S5b US-004 — the memory search tool through the real registry and executor against PG, and once through the
 * runner tool route (AC-13, SEAM-3).
 *
 * Acceptance setup: project `web` with `dev` as its DEVELOPER and the web thread's creator, project `ops` (three
 * memory items of its own) with an ADMIN-owned thread job, one enrolled runner holding both RUNNING THREAD jobs at
 * lease epoch 1, and every memory item seeded with an explicit `updatedAt`, so the order these ACs assert is the
 * test's, not the clock's.
 *
 * Run: cd apps/api && KODA_DB_TESTS=1 bun run test:scoped test/integration/fleet/assistant-memory-tools.integration.spec.ts
 */
import request from 'supertest';
import { NathApplication } from '@nathapp/nestjs-app';
import { PrismaService } from '@nathapp/nestjs-prisma';
import { Prisma, type PrismaClient } from '../../../src/generated/prisma/client';
import { AssistantToolExecutor } from '../../../src/fleet/assistant/assistant-tool.executor';
import { resetDb } from '../../helpers/reset-db';
import { bootHttpApp, data } from '../../helpers/http-app';
import { FleetHttpWorld, enrollRunner, seedFleetHttpWorld } from '../../helpers/fleet-fixtures';
import { ThreadJobSeed, seedThreadJobFor } from '../../helpers/thread-fixtures';

// The nax sandbox withholds host Postgres/Docker.
const describeIntegration = canRunDbTests() ? describe : describe.skip;
vi.setConfig({ testTimeout: 20_000 });

/** A `ctx.data(...)` opening line. */
const FENCE_OPEN = /^<<koda-data-[0-9a-f]{16}>>$/;
/** An item's first line: `memory:<id> <kind> <status> confidence <two decimals> updated <ISO time>`. */
const MEMORY_LINE = /^memory:(\S+) (\S+) (\S+) confidence (\d+\.\d{2}) updated (\d{4}-\d{2}-\d{2}T[\d:.]+Z)$/;

/** The payloads of every `ctx.data(...)` fence in a result, in order. */
const fencedLines = (content: string): string[] => {
  const lines = content.split('\n');
  const values: string[] = [];
  for (let index = 1; index < lines.length; index += 1) {
    const previous = lines[index - 1];
    const current = lines[index];
    if (previous !== undefined && current !== undefined && FENCE_OPEN.test(previous)) values.push(current);
  }
  return values;
};

/** The item ids a result names, in the order it names them. */
const memoryIds = (content: string): string[] =>
  content.split('\n').flatMap((line) => {
    const id = MEMORY_LINE.exec(line)?.[1];
    return id === undefined ? [] : [id];
  });

/** The kind of every item a result names, in order. */
const memoryKinds = (content: string): string[] =>
  content.split('\n').flatMap((line) => {
    const kind = MEMORY_LINE.exec(line)?.[2];
    return kind === undefined ? [] : [kind];
  });

/** `T0 + minutes`, so every seeded `updatedAt` is a fixed instant the assertions can spell out. */
const T0 = new Date('2026-10-01T00:00:00.000Z');
const at = (minutes: number): Date => new Date(T0.getTime() + minutes * 60_000);

describeIntegration('fleet assistant memory tool (PG, US-004)', () => {
  let app: NathApplication;
  let server: ReturnType<NathApplication['getHttpServer']>;
  let prisma: PrismaClient;
  let world: FleetHttpWorld;
  let runner: { runnerId: string; apiKey: string };
  let thread: ThreadJobSeed;
  let opsJobId: string;
  let executor: AssistantToolExecutor;
  const saved: Record<string, string | undefined> = {};

  /** The items the ACs read, by the name each AC uses. */
  interface Seed {
    keepActive: { id: string };
    deploy: { id: string };
    expiredDeploy: { id: string };
    flow: { id: string };
    objectMatch: { id: string };
    predicateMatch: { id: string };
    superseded: { id: string };
    decision: { id: string };
    orderingNewest: { id: string };
    orderingMiddle: { id: string };
    orderingOldest: { id: string };
    bulk: Array<{ id: string }>;
    opsDeploy: { id: string };
  }
  const seed = {} as Seed;

  interface Item {
    subject: string;
    predicate: string;
    object?: string | null;
    kind?: string;
    status?: string;
    confidence?: number;
    ttlAt?: Date | null;
    updatedAt: Date;
  }

  /** One memory item, with the fields the search reads spelled out by the caller. */
  const memory = (projectId: string, item: Item) =>
    prisma.memoryItem.create({ data: { projectId, kind: 'FACT', confidence: 0.8, ...item } });

  /** A RUNNING THREAD job of `projectId` owned by `creatorId`: what fixes the tool's project scope (S5b-R7). */
  const threadJobIn = async (projectId: string, repoId: string, creatorId: string, feature: string): Promise<string> => {
    const created = await prisma.chatThread.create({
      data: {
        projectId, repoId, baseRef: 'trunk', feature, title: 'Memory fixture', createdById: creatorId,
        backend: { kind: 'native', model: 'm1' }, skills: [], specPath: `.nax/features/${feature}/spec.md`,
      },
    });
    const job = await prisma.fleetJob.create({
      data: {
        projectId, repoId, ref: 'trunk', command: 'THREAD', feature: `thread-${created.id}`, profiles: [],
        selectorLabels: [], maxCostUsd: new Prisma.Decimal(5), requestedById: creatorId, state: 'RUNNING',
        runnerId: runner.runnerId, leaseEpoch: 1, firstStartedAt: new Date(), threadId: created.id,
      },
    });
    await prisma.fleetThreadTurn.create({
      data: {
        jobId: job.id, threadId: created.id, action: 'SESSION', instructions: 'go',
        backend: { kind: 'native', model: 'm1' }, skills: [], resume: false,
      },
    });
    return job.id;
  };

  const call = (toolCallId: string, input: unknown, jobId: string = thread.jobId) =>
    executor.execute({ jobId, toolCallId, name: 'koda_memory_search', input });

  const toolUrl = (jobId: string, name: string, leaseEpoch = 1): string =>
    `/api/fleet/runner/jobs/${jobId}/tools/${name}?leaseEpoch=${leaseEpoch}`;

  beforeAll(async () => {
    saved['FLEET_THREADS_ENABLED'] = process.env['FLEET_THREADS_ENABLED'];
    process.env['FLEET_THREADS_ENABLED'] = 'true';
    await resetDb();
    app = await bootHttpApp({ registrationEnabled: false });
    server = app.getHttpServer();
    prisma = app.get<PrismaService<PrismaClient>>(PrismaService).client;
    world = await seedFleetHttpWorld(server, prisma);
    runner = await enrollRunner(server, world.tokens.root, 'memory-tool-runner');
    thread = await seedThreadJobFor(prisma, world, runner, { feature: 'us004-memory' });
    opsJobId = await threadJobIn(world.opsProjectId, world.foreignRepoId, world.ids.root, 'us004-memory-ops');
    executor = app.get<AssistantToolExecutor>(AssistantToolExecutor, { strict: false });

    // The newest item in the project: `{}` answers one page of 20 by `updatedAt`, so it is always on page 1.
    seed.keepActive = await memory(world.projectId, {
      subject: 'Release cadence', predicate: 'rule', object: 'weekly', kind: 'PREFERENCE', confidence: 0.99, updatedAt: at(200),
    });
    seed.deploy = await memory(world.projectId, {
      subject: 'Deploy pipeline', predicate: 'status', object: 'green', confidence: 0.9, updatedAt: at(29),
    });
    seed.decision = await memory(world.projectId, {
      subject: 'Database choice', predicate: 'is', object: 'postgres', kind: 'DECISION', confidence: 0.8, updatedAt: at(28),
    });
    seed.flow = await memory(world.projectId, {
      subject: 'Ticket flow', predicate: 'state', object: 'ok', confidence: 0.7, updatedAt: at(27),
    });
    // AC-2: one item whose object and one whose predicate carry `in_progress`.
    seed.objectMatch = await memory(world.projectId, {
      subject: 'ticket:2', predicate: 'status', object: 'in_progress', confidence: 0.6, updatedAt: at(26),
    });
    seed.predicateMatch = await memory(world.projectId, {
      subject: 'ticket:3', predicate: 'in_progress_since', object: null, confidence: 0.6, updatedAt: at(25),
    });
    // AC-3: active, matches `deploy`, and its TTL is already past (relative to the run's clock, never a fixed date).
    seed.expiredDeploy = await memory(world.projectId, {
      subject: 'Deploy checklist', predicate: 'status', object: 'stale', confidence: 0.5,
      ttlAt: new Date(Date.now() - 86_400_000), updatedAt: at(24),
    });
    seed.superseded = await memory(world.projectId, {
      subject: 'Release cadence', predicate: 'rule', object: 'monthly', kind: 'PREFERENCE', status: 'superseded',
      confidence: 0.4, updatedAt: at(23),
    });
    // AC-7: three items no other search matches, with the order the answer must not change.
    seed.orderingNewest = await memory(world.projectId, {
      subject: 'ordering-probe newest', predicate: 'seen', object: 'third', confidence: 0.75, updatedAt: at(3),
    });
    seed.orderingMiddle = await memory(world.projectId, {
      subject: 'ordering-probe middle', predicate: 'seen', object: 'second', confidence: 0.75, updatedAt: at(2),
    });
    seed.orderingOldest = await memory(world.projectId, {
      subject: 'ordering-probe oldest', predicate: 'seen', object: 'first', confidence: 0.75, updatedAt: at(1),
    });
    // AC-8: 21 matches, the oldest one last in the answer's own order.
    seed.bulk = [];
    for (let index = 1; index <= 21; index += 1) {
      seed.bulk.push(await memory(world.projectId, {
        subject: `bulk-memory ${String(index).padStart(2, '0')}`, predicate: 'recorded', confidence: 0.5,
        updatedAt: at(60 + index),
      }));
    }
    // AC-9/AC-10: three items of project `ops`, one of them matching `deploy`.
    seed.opsDeploy = await memory(world.opsProjectId, {
      subject: 'Deploy pipeline ops', predicate: 'status', object: 'green', confidence: 0.9, updatedAt: at(10),
    });
    await memory(world.opsProjectId, { subject: 'Ops runbook', predicate: 'is', object: 'short', updatedAt: at(9) });
    await memory(world.opsProjectId, { subject: 'Ops oncall', predicate: 'rotates', object: 'weekly', updatedAt: at(8) });
  }, 60_000);

  afterAll(async () => {
    try {
      await app?.close();
    } finally {
      if (saved['FLEET_THREADS_ENABLED'] === undefined) delete process.env['FLEET_THREADS_ENABLED'];
      else process.env['FLEET_THREADS_ENABLED'] = saved['FLEET_THREADS_ENABLED'];
    }
  });

  it('AC-1: koda_memory_search { text: "deploy" } fences Deploy pipeline and leaves Ticket flow out', async () => {
    const result = await call('ac1', { text: 'deploy' });

    expect(result.isError).toBe(false);
    expect(fencedLines(result.content)).toContain('Deploy pipeline status green');
    expect(result.content).toMatch(/<<koda-data-[0-9a-f]{16}>>\nDeploy pipeline status green\n<<end-koda-data-[0-9a-f]{16}>>/);
    expect(memoryIds(result.content)).toContain(seed.deploy.id);
    expect(result.content).not.toContain('Ticket flow');
  });

  it('AC-2: koda_memory_search { text: "IN_PROG" } matches an object and a predicate case-insensitively', async () => {
    const result = await call('ac2', { text: 'IN_PROG' });

    expect(result.isError).toBe(false);
    expect(memoryIds(result.content)).toEqual(expect.arrayContaining([seed.objectMatch.id, seed.predicateMatch.id]));
    expect(fencedLines(result.content)).toContain('ticket:2 status in_progress');
    expect(fencedLines(result.content)).toContain('ticket:3 in_progress_since');
  });

  it('AC-3: koda_memory_search { text: "deploy" } leaves out the expired active match', async () => {
    const result = await call('ac3', { text: 'deploy' });

    // The row itself is active and does match the text: only its `ttlAt` takes it out of the answer.
    expect(await prisma.memoryItem.findUniqueOrThrow({ where: { id: seed.expiredDeploy.id } }))
      .toMatchObject({ status: 'active', subject: 'Deploy checklist' });
    expect(memoryIds(result.content)).toContain(seed.deploy.id);
    expect(memoryIds(result.content)).not.toContain(seed.expiredDeploy.id);
    expect(result.content).not.toContain('Deploy checklist');
  });

  it('AC-4: koda_memory_search {} answers an active item and leaves the superseded one out', async () => {
    const result = await call('ac4', {});

    expect(result.isError).toBe(false);
    expect(memoryIds(result.content)[0]).toBe(seed.keepActive.id);
    expect(memoryIds(result.content)).toContain(seed.keepActive.id);
    expect(memoryIds(result.content)).not.toContain(seed.superseded.id);
  });

  it('AC-5: koda_memory_search { status: "superseded" } answers the superseded item only', async () => {
    const result = await call('ac5', { status: 'superseded' });

    expect(result.isError).toBe(false);
    expect(memoryIds(result.content)).toEqual([seed.superseded.id]);
    expect(fencedLines(result.content)).toEqual(['Release cadence rule monthly']);
  });

  it('AC-6: koda_memory_search { kind: "DECISION" } answers DECISION items only', async () => {
    const result = await call('ac6', { kind: 'DECISION' });

    expect(result.isError).toBe(false);
    expect(memoryIds(result.content)).toEqual([seed.decision.id]);
    expect(memoryKinds(result.content)).toEqual(['DECISION']);
    // The whole answer, not just the header: a PREFERENCE may not appear anywhere.
    expect(result.content).not.toContain(seed.keepActive.id);
  });

  it('AC-7: koda_memory_search lists newest updatedAt first and formats each first line', async () => {
    const result = await call('ac7', { text: 'ordering-probe' });

    const lines = result.content.split('\n');
    expect(memoryIds(result.content)).toEqual([seed.orderingNewest.id, seed.orderingMiddle.id, seed.orderingOldest.id]);
    // Two lines per item: the header, then its fence; so the headers sit at 0, 4 and 8.
    expect(lines[0]).toBe(
      `memory:${seed.orderingNewest.id} FACT active confidence 0.75 updated ${at(3).toISOString()}`,
    );
    expect(lines[4]).toBe(
      `memory:${seed.orderingMiddle.id} FACT active confidence 0.75 updated ${at(2).toISOString()}`,
    );
    expect(lines[8]).toBe(
      `memory:${seed.orderingOldest.id} FACT active confidence 0.75 updated ${at(1).toISOString()}`,
    );
    for (const line of lines) {
      if (line.startsWith('memory:')) expect(line).toMatch(MEMORY_LINE);
    }
  });

  it('AC-8: 21 matches answer 20 items plus the next-page line, and page 2 answers the 21st', async () => {
    const first = await call('ac8a', { text: 'bulk-memory' });

    expect(first.isError).toBe(false);
    const firstIds = memoryIds(first.content);
    expect(firstIds).toHaveLength(20);
    // Newest first: the 21 seeded items are `bulk-memory 01` (oldest) .. `bulk-memory 21` (newest).
    const expected = [...seed.bulk].reverse();
    expect(firstIds).toEqual(expected.slice(0, 20).map((item) => item.id));
    expect(first.content.split('\n').at(-1)).toBe('more: call koda_memory_search with page 2');

    const second = await call('ac8b', { text: 'bulk-memory', page: 2 });

    expect(second.isError).toBe(false);
    expect(memoryIds(second.content)).toEqual([expected[20]?.id]);
    expect(second.content).not.toContain('more:');
  });

  it('AC-9: a page past the last of three items answers the single line no memory items', async () => {
    // Project `ops` holds exactly three items, the smallest set the ops thread job scopes.
    expect(await prisma.memoryItem.count({ where: { projectId: world.opsProjectId } })).toBe(3);

    const result = await call('ac9', { page: 5 }, opsJobId);

    expect(result.isError).toBe(false);
    expect(result.content).toBe('no memory items');
  });

  it('AC-10: koda_memory_search never answers an item of another project', async () => {
    const result = await call('ac10', { text: 'deploy' });

    expect(memoryIds(result.content)).toContain(seed.deploy.id);
    expect(memoryIds(result.content)).not.toContain(seed.opsDeploy.id);
    expect(result.content).not.toContain('Deploy pipeline ops');

    // The same text in the other project's thread answers that project's item, and never the web one.
    const ops = await call('ac10-ops', { text: 'deploy' }, opsJobId);
    expect(memoryIds(ops.content)).toEqual([seed.opsDeploy.id]);
    expect(fencedLines(ops.content)).toEqual(['Deploy pipeline ops status green']);
    expect(memoryIds(ops.content)).not.toContain(seed.deploy.id);
  });

  it('AC-13: the holder of a RUNNING THREAD job searches memory through the runner route', async () => {
    const res = await request(server)
      .post(toolUrl(thread.jobId, 'koda_memory_search'))
      .set({ Authorization: `Bearer ${runner.apiKey}` })
      .send({ toolCallId: 'm1', input: { text: 'deploy' } })
      .expect(200);

    expect(data<{ content: string; isError: boolean }>(res)).toMatchObject({ isError: false });
    expect(data<{ content: string }>(res).content).toContain('Deploy pipeline');
  });
});
