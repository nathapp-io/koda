import { canRunDbTests } from '../../helpers/test-environment';
/**
 * Fleet AGENT job US-003 — the two agent columns over PG: written on insert, patched by the mirror, cleared on requeue.
 *
 * The repository ACs drive `PrismaFleetJobRepository` against the schema `prisma db push` builds from `schema.prisma`,
 * so they cover the insert writer, `toJob` and the patch writer with a real JSON column. AC-9 drives the real requeue
 * route (`POST /projects/web/fleet/jobs/:id/requeue`), because the reset patch that clears the result lives in
 * `FleetJobsService.requeue`.
 *
 * The fixture world is the HTTP one (project `web`, repository `acme/app`, `dev` as a developer): its first-user
 * registration is what the boot allows, so the whole file seeds through it instead of writing a user of its own.
 * Run: cd apps/api && bun run test:db:up && KODA_DB_TESTS=1 bunx vitest run test/integration/fleet/fleet-job-agent-persistence.integration.spec.ts
 */
import request from 'supertest';
import { NathApplication } from '@nathapp/nestjs-app';
import { Prisma, PrismaClient } from '../../../src/generated/prisma/client';
import { PrismaService } from '@nathapp/nestjs-prisma';
import { resetDb } from '../../helpers/reset-db';
import { createTestPrismaClient } from '../../helpers/test-prisma';
import { bootHttpApp } from '../../helpers/http-app';
import { expectGuardActive, fixtureDb } from '../../helpers/action-context';
import { FleetHttpWorld, seedFleetHttpWorld } from '../../helpers/fleet-fixtures';
import { PrismaFleetJobRepository } from '../../../src/fleet/jobs/prisma-fleet-job.repository';
import type { NewFleetJob } from '../../../src/fleet/jobs/domain/fleet-job.domain';
import type { AgentJobResult } from '../../../src/fleet/common/agent-jobs';

// The nax sandbox withholds host Postgres/Docker.
const describeIntegration = canRunDbTests() ? describe : describe.skip;
vi.setConfig({ testTimeout: 60_000 });

const INPUT = { name: 'spec-reviewer', task: 'x' };
const RESULT: AgentJobResult = {
  status: 'completed', output: 'done', truncated: false, deniedAsks: [], deniedAsksTruncated: false, costUsd: '0.0123',
};

describeIntegration('fleet AGENT job persistence (PG, US-003)', () => {
  // The repository writes through a client of its own: the app's client refuses a write with no action context, and
  // what these cases exercise is the persistence mapping, not the guard.
  const prisma = createTestPrismaClient();
  const repo = new PrismaFleetJobRepository({ client: prisma } as unknown as PrismaService<PrismaClient>);
  let app: NathApplication;
  let server: ReturnType<NathApplication['getHttpServer']>;
  let db: PrismaClient;
  let world: FleetHttpWorld;
  let base: Pick<NewFleetJob, 'projectId' | 'repoId' | 'ref' | 'planFrom' | 'profiles' | 'maxCostUsd' | 'bashMode' | 'approvalTimeoutSec' | 'selectorLabels' | 'pinnedRunnerId' | 'requestedById'>;

  /** A new job of this test's own feature, so no case shares a row (or the active-job index) with another. */
  const newJob = (feature: string, over: Partial<NewFleetJob> = {}): NewFleetJob =>
    ({ ...base, command: 'AGENT', feature, ...over });

  /** Both columns exactly as the database stores them: SQL NULL answers null, a JSON null would answer 'null'. */
  const rawStored = (id: string): Promise<Array<{ agentInput: string | null; agentResult: string | null }>> =>
    prisma.$queryRawUnsafe<Array<{ agentInput: string | null; agentResult: string | null }>>(
      `SELECT "agentInput"::text AS "agentInput", "agentResult"::text AS "agentResult" FROM "FleetJob" WHERE "id" = $1`, id,
    );

  /** The same two columns as values (jsonb rendering is Postgres' business, the stored value is ours). */
  const stored = async (id: string): Promise<Array<{ agentInput: unknown; agentResult: unknown }>> => {
    const parse = (text: string | null): unknown => (text === null ? null : JSON.parse(text));
    return (await rawStored(id)).map((row) => ({ agentInput: parse(row.agentInput), agentResult: parse(row.agentResult) }));
  };

  beforeAll(async () => {
    await resetDb();
    app = await bootHttpApp({ registrationEnabled: false });
    server = app.getHttpServer();
    db = fixtureDb(app);
    world = await seedFleetHttpWorld(server, db);
    base = {
      projectId: world.projectId, repoId: world.repoId, ref: 'trunk', planFrom: null, profiles: [], maxCostUsd: '5',
      bashMode: 'raw', approvalTimeoutSec: 600, selectorLabels: [], pinnedRunnerId: null, requestedById: world.ids.dev,
    };
  }, 120_000);

  afterAll(async () => {
    try {
      await app?.close();
    } finally {
      await prisma.$disconnect();
    }
  });

  it('AC-1: an AGENT job stores its agentInput and reads it back with a null agentResult', async () => {
    const created = await repo.createJob(newJob('agent-roundtrip', { agentInput: INPUT }));
    expect(created.agentInput).toEqual(INPUT);
    expect(created.agentResult).toBeNull();

    const read = await repo.findById(created.id);
    expect(read).toEqual(expect.objectContaining({ command: 'AGENT', agentInput: INPUT, agentResult: null }));
    expect(await stored(created.id)).toEqual([{ agentInput: INPUT, agentResult: null }]);
  });

  it('AC-2: a RUN job inserted with no agentInput key has both columns SQL null', async () => {
    const created = await repo.createJob(newJob('run-no-agent', { command: 'RUN' }));
    const read = await repo.findById(created.id);
    expect(read).toEqual(expect.objectContaining({ command: 'RUN', agentInput: null, agentResult: null }));
    // 'null'::text would mean JSON null was stored; null means the column really is SQL NULL.
    expect(await rawStored(created.id)).toEqual([{ agentInput: null, agentResult: null }]);
  });

  it('AC-3: patching an AGENT job with an agentResult stores it and reads it back', async () => {
    const created = await repo.createJob(newJob('agent-result', { agentInput: INPUT }));
    expect((await repo.update(created.id, { agentResult: RESULT })).agentResult).toEqual(RESULT);

    expect((await repo.findById(created.id))?.agentResult).toEqual(RESULT);
    // The input is not touched by a result patch.
    expect((await repo.findById(created.id))?.agentInput).toEqual(INPUT);
  });

  it('AC-4: patching an agentResult with null clears the column', async () => {
    const created = await repo.createJob(newJob('agent-result-clear', { agentInput: INPUT }));
    await repo.update(created.id, { agentResult: RESULT });
    expect((await repo.findById(created.id))?.agentResult).toEqual(RESULT);

    expect((await repo.update(created.id, { agentResult: null })).agentResult).toBeNull();
    expect((await repo.findById(created.id))?.agentResult).toBeNull();
    expect(await stored(created.id)).toEqual([{ agentInput: INPUT, agentResult: null }]);
  });

  it('keeps the agentInput when a patch names no agent field', async () => {
    const created = await repo.createJob(newJob('agent-input-sticky', { agentInput: INPUT }));
    await repo.update(created.id, { currentPhase: 'run' });
    expect((await repo.findById(created.id))?.agentInput).toEqual(INPUT);
  });

  it('writes need an action context', async () => {
    await expect(expectGuardActive(app)).resolves.toBeUndefined();
  });

  it('AC-9: requeueing a FAILED AGENT job clears its result and keeps its input', async () => {
    const job = await db.fleetJob.create({
      data: {
        projectId: world.projectId, repoId: world.repoId, ref: 'trunk', command: 'AGENT', feature: 'agent-requeue',
        profiles: [], maxCostUsd: new Prisma.Decimal(1), requestedById: world.ids.dev, state: 'FAILED', finishedAt: new Date(),
        agentInput: INPUT, agentResult: RESULT,
        // A label no runner carries: the requeued job stays QUEUED instead of taking a runner's slot.
        selectorLabels: ['no-such-label'],
      },
    });

    // The attempt's result is really there before the requeue, so the null below is a clear and not an empty column.
    expect(await stored(job.id)).toEqual([{ agentInput: INPUT, agentResult: RESULT }]);

    await request(server).post(`/api/projects/web/fleet/jobs/${job.id}/requeue`)
      .set({ Authorization: `Bearer ${world.tokens.dev}` }).expect(200);

    const after = await db.fleetJob.findUniqueOrThrow({ where: { id: job.id } });
    expect(after).toEqual(expect.objectContaining({ command: 'AGENT', state: 'QUEUED', agentInput: INPUT, agentResult: null }));
    // The input is dispatch-time, so the requeue keeps it; only the attempt's result is cleared.
    expect(await stored(job.id)).toEqual([{ agentInput: INPUT, agentResult: null }]);
  });
});
