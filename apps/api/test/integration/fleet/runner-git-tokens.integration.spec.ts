/**
 * Fleet S1 slice 2b — POST /fleet/runner/sync git tokens: fence, mint, never store (PG).
 * Run: cd apps/api && bun run test:scoped test/integration/fleet/runner-git-tokens.integration.spec.ts
 */
import request from 'supertest';
import { generateKeyPairSync } from 'crypto';
import { mkdtempSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { NathApplication } from '@nathapp/nestjs-app';
import { PrismaService } from '@nathapp/nestjs-prisma';
import { PrismaClient } from '../../../src/generated/prisma/client';
import { resetDb } from '../../helpers/reset-db';
import { bootHttpApp, data } from '../../helpers/http-app';
import { enrollRunner, FleetHttpWorld, seedFleetHttpWorld, syncBody } from '../../helpers/fleet-fixtures';
import { FakeForge, startFakeForge } from '../../helpers/fake-forge';
import type { SyncRequest, SyncResponse } from '../../../src/fleet/common/protocol';

const describeIntegration = process.env.KODA_DB_TESTS === '1' ? describe : describe.skip;
const ENV_KEYS = ['GITHUB_API_URL', 'GITHUB_APP_ID', 'GITHUB_APP_PRIVATE_KEY_FILE', 'GITHUB_APP_SLUG'] as const;

describeIntegration('runner git tokens (PG)', () => {
  let app: NathApplication;
  let server: ReturnType<NathApplication['getHttpServer']>;
  let prisma: PrismaClient;
  let world: FleetHttpWorld;
  let runner: { runnerId: string; apiKey: string };
  let forge: FakeForge;
  const saved: Record<string, string | undefined> = {};
  const savedWait = process.env.FLEET_SYNC_WAIT_MS;

  const sync = async (over: Partial<SyncRequest> = {}, key = runner.apiKey) =>
    data<SyncResponse>(await request(server).post('/api/fleet/runner/sync').set({ Authorization: `Bearer ${key}` }).send(syncBody(over)).expect(200));
  const dispatch = async (feature: string) =>
    data<{ job: { id: string; state: string; leaseEpoch: number } }>(
      await request(server).post('/api/projects/web/fleet/jobs').set({ Authorization: `Bearer ${world.tokens.dev}` })
        .send({ repoId: world.repoId, command: 'RUN', maxCostUsd: 5, feature }).expect(201),
    ).job;

  beforeAll(async () => {
    forge = await startFakeForge();
    const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
    const keyFile = join(mkdtempSync(join(tmpdir(), 'gh-app-')), 'app.pem');
    writeFileSync(keyFile, privateKey.export({ type: 'pkcs1', format: 'pem' }));
    for (const k of ENV_KEYS) saved[k] = process.env[k];
    Object.assign(process.env, {
      GITHUB_API_URL: forge.url, GITHUB_APP_ID: '4242',
      GITHUB_APP_PRIVATE_KEY_FILE: keyFile, GITHUB_APP_SLUG: 'koda-fleet',
    });
    process.env.FLEET_SYNC_WAIT_MS = '0';

    forge.routes.set('POST /app/installations/77/access_tokens', () => ({
      status: 201, body: { token: 'ghs_brokered', expires_at: new Date(Date.now() + 60 * 60_000).toISOString() },
    }));

    await resetDb();
    app = await bootHttpApp({ registrationEnabled: false });
    server = app.getHttpServer();
    prisma = app.get<PrismaService<PrismaClient>>(PrismaService).client;
    world = await seedFleetHttpWorld(server, prisma);
    runner = await enrollRunner(server, world.tokens.root, 'box-1');
  });
  afterAll(async () => {
    await app.close();
    await forge.close();
    for (const k of ENV_KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
    if (savedWait === undefined) delete process.env.FLEET_SYNC_WAIT_MS;
    else process.env.FLEET_SYNC_WAIT_MS = savedWait;
  });

  it('mints for the current lease only; a stale epoch gets nothing and one ABANDON', async () => {
    const j = await dispatch('tok');
    const res = await sync({ tokenRequests: [{ jobId: j.id, leaseEpoch: j.leaseEpoch }] });
    expect(res.gitTokens).toEqual([expect.objectContaining({ jobId: j.id, token: 'ghs_brokered', username: 'x-access-token' })]);

    const stale = await sync({ tokenRequests: [{ jobId: j.id, leaseEpoch: j.leaseEpoch + 5 }] });
    expect(stale.gitTokens).toEqual([]);
    await sync({ tokenRequests: [{ jobId: j.id, leaseEpoch: j.leaseEpoch + 5 }] });
    expect(await prisma.fleetCommand.count({ where: { jobId: j.id, type: 'ABANDON' } })).toBe(1);

    await prisma.fleetJob.update({ where: { id: j.id }, data: { state: 'COMPLETED' } });
    const done = await sync({ tokenRequests: [{ jobId: j.id, leaseEpoch: j.leaseEpoch }] });
    expect(done.gitTokens).toEqual([]);
    expect(done.gitTokenErrors).toEqual([{ jobId: j.id, reason: 'job_not_active' }]);
    expect((await sync({ tokenRequests: [{ jobId: 'ghost', leaseEpoch: 1 }] })).unknownJobIds).toEqual(['ghost']);
  });

  it('never stores the token (spec §7.1)', async () => {
    const tables = await Promise.all([
      prisma.fleetCommand.findMany(), prisma.fleetActivity.findMany(), prisma.fleetJobEvent.findMany(), prisma.fleetJob.findMany(),
    ]);
    expect(JSON.stringify(tables, (_k, v) => (typeof v === 'bigint' ? v.toString() : v))).not.toContain('ghs_brokered');
  });
});
