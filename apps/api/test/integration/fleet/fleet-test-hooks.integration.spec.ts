/**
 * Fleet S1b slice 3b (plan D213): the test-only fire hook over HTTP, booted with FLEET_TEST_HOOKS=true (PG).
 * Run: cd apps/api && KODA_DB_TESTS=1 bun run test:scoped test/integration/fleet/fleet-test-hooks.integration.spec.ts
 */
import request from 'supertest';
import { NathApplication } from '@nathapp/nestjs-app';
import { PrismaService } from '@nathapp/nestjs-prisma';
import { PrismaClient } from '../../../src/generated/prisma/client';
import { resetDb } from '../../helpers/reset-db';
import { bootHttpApp, data } from '../../helpers/http-app';
import { FleetHttpWorld, seedFleetHttpWorld } from '../../helpers/fleet-fixtures';

const describeIntegration = process.env.KODA_DB_TESTS === '1' ? describe : describe.skip;

jest.setTimeout(30_000);

interface Row { id: string; nextFireAt: string; lastJobId: string | null }

describeIntegration('fleet test hooks (PG)', () => {
  let app: NathApplication;
  let server: ReturnType<NathApplication['getHttpServer']>;
  let prisma: PrismaClient;
  let world: FleetHttpWorld;
  let n = 0;
  const as = (token: string) => ({ Authorization: `Bearer ${token}` });
  const BASE = '/api/projects/web/fleet/schedules';
  const fire = (id: string, token: string) => request(server).post(`/api/fleet/test-hooks/schedules/${id}/fire`).set(as(token));
  const create = async () => data<Row>(await request(server).post(BASE).set(as(world.tokens.dev)).send({
    name: 'hook', repoId: world.repoId, feature: `hook${++n}`, cron: '0 3 1 1 *', timezone: 'UTC', maxCostUsd: 5,
  }).expect(201));

  beforeAll(async () => {
    await resetDb();
    // Config factories read process.env during AppFactory.create (see bootHttpApp).
    const previous = process.env.FLEET_TEST_HOOKS;
    process.env.FLEET_TEST_HOOKS = 'true';
    try {
      app = await bootHttpApp({ registrationEnabled: false });
    } finally {
      if (previous === undefined) delete process.env.FLEET_TEST_HOOKS;
      else process.env.FLEET_TEST_HOOKS = previous;
    }
    server = app.getHttpServer();
    prisma = app.get<PrismaService<PrismaClient>>(PrismaService).client;
    world = await seedFleetHttpWorld(server, prisma);
  });
  afterAll(async () => {
    await app.close();
  });
  beforeEach(async () => {
    await prisma.fleetJob.deleteMany();
    await prisma.jobSchedule.deleteMany();
  });

  it('a global admin fires a schedule that is not due yet: one RUN as the owner, linked as lastJobId, next fire moved on', async () => {
    const created = await create();
    const res = data<{ firedAt: string; result: { claimed: number; dispatched: number } }>(await fire(created.id, world.tokens.root).expect(200));
    expect(res.firedAt).toBe(created.nextFireAt);
    expect(res.result).toEqual(expect.objectContaining({ claimed: 1, dispatched: 1 }));

    const job = await prisma.fleetJob.findFirstOrThrow({ where: { scheduleId: created.id } });
    // `n` is the suffix create() just used.
    expect(job).toEqual(expect.objectContaining({ command: 'RUN', feature: `hook${n}`, requestedById: world.ids.dev }));
    const after = data<Row>(await request(server).get(`${BASE}/${created.id}`).set(as(world.tokens.dev)).expect(200));
    expect(after.lastJobId).toBe(job.id);
    expect(new Date(after.nextFireAt).getTime()).toBeGreaterThan(new Date(created.nextFireAt).getTime());
  });

  it('refuses a project developer, and answers 404 for an unknown schedule', async () => {
    const created = await create();
    await fire(created.id, world.tokens.dev).expect(403);
    await fire('no-such-schedule', world.tokens.root).expect(404);
    expect(await prisma.fleetJob.count()).toBe(0);
  });

  it('refuses a disabled schedule with 409 and dispatches nothing (issue #192 item 3)', async () => {
    const created = await create();
    await request(server).post(`${BASE}/${created.id}/disable`).set(as(world.tokens.dev)).expect(200);
    const res = await fire(created.id, world.tokens.root).expect(409);
    expect(res.body.message).toContain('disabled');
    expect(await prisma.fleetJob.count()).toBe(0);
  });
});
