/* eslint-disable @typescript-eslint/no-non-null-assertion -- the brief's test code asserts command presence with ! */
/**
 * Fleet S1 slice 2b — PR/MR attribution: one "Dispatched by <user> via koda job <id>" comment
 * on the job's own PR, once, never on another repo (plan D19, PG).
 * Run: cd apps/api && bun run test:scoped test/integration/fleet/pr-attribution.integration.spec.ts
 */
import request from 'supertest';
import { generateKeyPairSync } from 'crypto';
import { mkdtempSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { NathApplication } from '@nathapp/nestjs-app';
import { PrismaService } from '@nathapp/nestjs-prisma';
import { PrismaClient } from '@prisma/client';
import { resetDb } from '../../helpers/reset-db';
import { bootHttpApp, data } from '../../helpers/http-app';
import { enrollRunner, FleetHttpWorld, seedFleetHttpWorld, syncBody } from '../../helpers/fleet-fixtures';
import { FakeForge, startFakeForge } from '../../helpers/fake-forge';
import { PrAttributionService } from '../../../src/fleet/sync/pr-attribution.service';
import type { SyncRequest, SyncResponse } from '../../../src/fleet/common/protocol';

const describeIntegration = process.env.KODA_DB_TESTS === '1' ? describe : describe.skip;
const ENV_KEYS = ['GITHUB_API_URL', 'GITHUB_APP_ID', 'GITHUB_APP_PRIVATE_KEY_FILE', 'GITHUB_APP_SLUG'] as const;

describeIntegration('pr attribution (PG)', () => {
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

  const waitFor = async (pred: () => boolean, ms = 2_000) => {
    const end = Date.now() + ms;
    while (!pred() && Date.now() < end) await new Promise((r) => setTimeout(r, 25));
    return pred();
  };
  const runToCompletion = async (feature: string, prUrl: string) => {
    const j = await dispatch(feature);
    const assign = (await sync()).commands.find((c) => c.jobId === j.id && c.type === 'ASSIGN')!;
    await sync({
      commandAcks: [{ commandId: assign.commandId, leaseEpoch: j.leaseEpoch, result: 'ok' }],
      jobs: [{ jobId: j.id, leaseEpoch: j.leaseEpoch, events: [
        { seq: 1, type: 'state', payload: { to: 'RUNNING' } },
        { seq: 2, type: 'snapshot', payload: { resultPrUrl: prUrl } },
        { seq: 3, type: 'state', payload: { to: 'UPLOADING' } },
        { seq: 4, type: 'state', payload: { to: 'COMPLETED' } },
      ] }],
    });
    return j;
  };

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
    forge.routes.set('POST /repos/acme/app/issues/12/comments', () => ({ status: 201, body: { id: 1 } }));

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

  it('comments once on the job\'s own PR, naming the requester by name', async () => {
    const j = await runToCompletion('attr', 'https://github.com/acme/app/pull/12');
    const comments = () => forge.requests.filter((r) => r.method === 'POST' && r.path === '/repos/acme/app/issues/12/comments');
    expect(await waitFor(() => comments().length === 1)).toBe(true);
    expect((comments()[0].body as { body: string }).body).toBe(`Dispatched by dev via koda job ${j.id}`);
    await expect(app.get(PrAttributionService).attribute(j.id)).resolves.toBe('skipped');
    expect(comments()).toHaveLength(1);
  });

  it('never comments on a PR of another repo (review focus 5)', async () => {
    await runToCompletion('attr-evil', 'https://github.com/evil/repo/pull/1');
    await new Promise((r) => setTimeout(r, 300));
    expect(forge.requests.some((r) => r.path.startsWith('/repos/evil'))).toBe(false);
  });
});
