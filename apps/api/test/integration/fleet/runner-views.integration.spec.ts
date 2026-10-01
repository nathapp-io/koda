/**
 * Fleet S1 slice 4a: the admin runner view (bootId, bootedAt, online; #158, D116, D117, D131).
 * Run: cd apps/api && bun run test:scoped test/integration/fleet/runner-views.integration.spec.ts
 */
import request from 'supertest';
import { NathApplication } from '@nathapp/nestjs-app';
import { PrismaService } from '@nathapp/nestjs-prisma';
import { PrismaClient } from '@prisma/client';
import { resetDb } from '../../helpers/reset-db';
import { bootHttpApp, data } from '../../helpers/http-app';
import { enrollRunner, FleetHttpWorld, seedFleetHttpWorld, syncBody } from '../../helpers/fleet-fixtures';

const describeIntegration = process.env.KODA_DB_TESTS === '1' ? describe : describe.skip;

interface AdminRunner { id: string; bootId: string; bootedAt: string | null; online: boolean; enabled: boolean }

describeIntegration('fleet runner views (PG)', () => {
  let app: NathApplication;
  let server: ReturnType<NathApplication['getHttpServer']>;
  let prisma: PrismaClient;
  let world: FleetHttpWorld;
  let runner: { runnerId: string; apiKey: string };
  const savedWait = process.env.FLEET_SYNC_WAIT_MS;
  const auth = (t: string) => ({ Authorization: `Bearer ${t}` });
  const adminGet = async (id: string) =>
    data<AdminRunner>(await request(server).get(`/api/fleet/runners/${id}`).set(auth(world.tokens.root)).expect(200));
  const sync = (bootId: string) =>
    request(server).post('/api/fleet/runner/sync').set(auth(runner.apiKey)).send(syncBody({ bootId })).expect(200);

  beforeAll(async () => {
    process.env.FLEET_SYNC_WAIT_MS = '200'; // an idle sync returns after 200 ms instead of 25 s
    await resetDb();
    app = await bootHttpApp({ registrationEnabled: false });
    server = app.getHttpServer();
    prisma = app.get<PrismaService<PrismaClient>>(PrismaService).client;
    world = await seedFleetHttpWorld(server, prisma);
    runner = await enrollRunner(server, world.tokens.root, 'box-1');
  });

  afterAll(async () => {
    await app.close();
    if (savedWait === undefined) delete process.env.FLEET_SYNC_WAIT_MS;
    else process.env.FLEET_SYNC_WAIT_MS = savedWait;
  });

  it('shows bootId, bootedAt and online on the admin view (#158)', async () => {
    const r = await adminGet(runner.runnerId);
    expect(r.bootId).toBe('boot-1');
    expect(r.bootedAt).toEqual(expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/));
    expect(r.online).toBe(true);
    const page = data<{ records: AdminRunner[] }>(await request(server).get('/api/fleet/runners').set(auth(world.tokens.root)).expect(200));
    expect(page.records[0]).toEqual(expect.objectContaining({ bootId: 'boot-1', online: true }));
  });

  it('moves bootedAt on a new boot id only', async () => {
    const before = (await adminGet(runner.runnerId)).bootedAt;
    await sync('boot-1');
    expect((await adminGet(runner.runnerId)).bootedAt).toBe(before);
    await sync('boot-2');
    const after = await adminGet(runner.runnerId);
    expect(after.bootId).toBe('boot-2');
    expect(Date.parse(after.bootedAt ?? '')).toBeGreaterThan(Date.parse(before ?? ''));
  });

  it('keeps bootedAt null for a runner row from before the migration', async () => {
    await prisma.runner.update({ where: { id: runner.runnerId }, data: { bootedAt: null } });
    expect((await adminGet(runner.runnerId)).bootedAt).toBeNull();
    await sync('boot-2');
    expect((await adminGet(runner.runnerId)).bootedAt).toBeNull();
  });

  it('reports offline once lastSeenAt is older than FLEET_RUNNER_OFFLINE_SEC, whatever enabled says', async () => {
    await prisma.runner.update({ where: { id: runner.runnerId }, data: { lastSeenAt: new Date(Date.now() - 10 * 60_000) } });
    const r = await adminGet(runner.runnerId);
    expect(r.online).toBe(false);
    expect(r.enabled).toBe(true);
  });
});
