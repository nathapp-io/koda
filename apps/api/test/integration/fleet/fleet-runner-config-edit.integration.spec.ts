/**
 * Fleet S3 §3 — the runner's lease-fenced edit-set fetch (PG).
 * Run: cd apps/api && bun run test:scoped test/integration/fleet/fleet-runner-config-edit.integration.spec.ts
 */
import request from 'supertest';
import { NathApplication } from '@nathapp/nestjs-app';
import { PrismaService } from '@nathapp/nestjs-prisma';
import { Prisma, PrismaClient } from '../../../src/generated/prisma/client';
import { resetDb } from '../../helpers/reset-db';
import { bootHttpApp, data } from '../../helpers/http-app';
import { enrollRunner, FLEET_CAPS, FleetHttpWorld, seedFleetHttpWorld } from '../../helpers/fleet-fixtures';

const describeIntegration = process.env.KODA_DB_TESTS === '1' ? describe : describe.skip;
const CAPS = { ...FLEET_CAPS, configJobs: true as const };
const EDITS = [{ path: '.nax/context.md', op: 'put', content: '# x', baseSha: null }];

describeIntegration('fleet runner config-edit fetch (PG)', () => {
  let app: NathApplication;
  let server: ReturnType<NathApplication['getHttpServer']>;
  let prisma: PrismaClient;
  let world: FleetHttpWorld;
  let box1: { runnerId: string; apiKey: string };
  let box2: { runnerId: string; apiKey: string };
  let n = 0;

  const job = async (over: { command?: string; state?: string; runnerId?: string; leaseEpoch?: number; withEdit?: boolean } = {}) => {
    const created = await prisma.fleetJob.create({
      data: {
        projectId: world.projectId, repoId: world.repoId, ref: 'trunk', command: over.command ?? 'CONFIG_EDIT', feature: `cfg-${++n}`, profiles: [],
        selectorLabels: [], maxCostUsd: new Prisma.Decimal(0), requestedById: world.ids.dev, state: over.state ?? 'ASSIGNED',
        runnerId: over.runnerId ?? box1.runnerId, leaseEpoch: over.leaseEpoch ?? 1,
      },
    });
    if (over.withEdit !== false) {
      await prisma.fleetConfigEdit.create({ data: { jobId: created.id, mode: 'edit', edits: EDITS, prTitle: 'T', baseSha: 'a'.repeat(40) } });
    }
    return created.id;
  };
  const fetchAs = (runner: { apiKey: string }, jobId: string, epoch: string | null = '1') =>
    request(server).get(`/api/fleet/runner/jobs/${jobId}/config-edit`).query(epoch === null ? {} : { leaseEpoch: epoch }).set({ Authorization: `Bearer ${runner.apiKey}` });

  beforeAll(async () => {
    await resetDb();
    app = await bootHttpApp({ registrationEnabled: false });
    server = app.getHttpServer();
    prisma = app.get<PrismaService<PrismaClient>>(PrismaService).client;
    world = await seedFleetHttpWorld(server, prisma);
    box1 = await enrollRunner(server, world.tokens.root, 'box-1', { capabilities: CAPS });
    box2 = await enrollRunner(server, world.tokens.root, 'box-2', { capabilities: CAPS });
  });
  afterAll(async () => {
    await app.close();
  });

  it.each(['ASSIGNED', 'RUNNING'])('serves the edit set to the holder in %s', async (state) => {
    const id = await job({ state });
    expect(data(await fetchAs(box1, id).expect(200))).toEqual({ mode: 'edit', edits: EDITS, prTitle: 'T', prBody: null, baseSha: 'a'.repeat(40) });
  });

  it('fences a stale epoch and another runner with 409 and queues ABANDON', async () => {
    const id = await job({ leaseEpoch: 2 });
    await fetchAs(box1, id, '1').expect(409);
    await fetchAs(box2, id, '2').expect(409);
    const abandons = await prisma.fleetCommand.findMany({ where: { jobId: id, type: 'ABANDON' } });
    expect(abandons.map((c) => c.runnerId).sort()).toEqual([box1.runnerId, box2.runnerId].sort());
  });

  it('answers 409 in UPLOADING, 404 for a nax job or a job without an edit row, 400 without a valid epoch', async () => {
    await fetchAs(box1, await job({ state: 'UPLOADING' })).expect(409);
    await fetchAs(box1, await job({ command: 'RUN', withEdit: false })).expect(404);
    await fetchAs(box1, await job({ withEdit: false })).expect(404);
    const id = await job();
    await fetchAs(box1, id, null).expect(400);
    await fetchAs(box1, id, '-1').expect(400);
  });

  it('refuses a user token (runner route only)', async () => {
    const id = await job();
    await request(server).get(`/api/fleet/runner/jobs/${id}/config-edit`).query({ leaseEpoch: '1' }).set({ Authorization: `Bearer ${world.tokens.root}` }).expect(401);
  });
});
