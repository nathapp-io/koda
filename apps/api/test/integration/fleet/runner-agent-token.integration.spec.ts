import { canRunDbTests } from '../../helpers/test-environment';
/**
 * US-005 AC-10/AC-11 — a held AGENT job's default token request gets the read purpose (PG, real broker + fake forge).
 * Run: cd apps/api && bun run test:scoped test/integration/fleet/runner-agent-token.integration.spec.ts
 */
import request from 'supertest';
import { generateKeyPairSync } from 'crypto';
import { mkdtempSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { NathApplication } from '@nathapp/nestjs-app';
import { PrismaClient } from '../../../src/generated/prisma/client';
import { resetDb } from '../../helpers/reset-db';
import { bootHttpApp, data } from '../../helpers/http-app';
import { enrollRunner, FleetHttpWorld, FLEET_CAPS, seedFleetHttpWorld, syncBody } from '../../helpers/fleet-fixtures';
import { FakeForge, startFakeForge } from '../../helpers/fake-forge';
import type { SyncRequest, SyncResponse } from '../../../src/fleet/common/protocol';
import { GitTokenBroker } from '../../../src/fleet/git-broker/git-token.broker';
import { expectGuardActive, fixtureDb } from '../../helpers/action-context';

// The nax sandbox withholds host Postgres/Docker.
const describeIntegration = canRunDbTests() ? describe : describe.skip;
const ENV_KEYS = ['GITHUB_API_URL', 'GITHUB_APP_ID', 'GITHUB_APP_PRIVATE_KEY_FILE', 'GITHUB_APP_SLUG'] as const;

/** The permissions a mint asked the App API for. */
const READ_ONLY_PERMISSIONS = { contents: 'read', metadata: 'read' };

describeIntegration('AGENT read-only token on sync (PG)', () => {
  let app: NathApplication;
  let server: ReturnType<NathApplication['getHttpServer']>;
  let prisma: PrismaClient;
  let world: FleetHttpWorld;
  let runner: { runnerId: string; apiKey: string };
  let forge: FakeForge;
  let mint: ReturnType<typeof vi.spyOn>;
  const saved: Record<string, string | undefined> = {};
  const savedWait = process.env.FLEET_SYNC_WAIT_MS;

  const sync = async (over: Partial<SyncRequest> = {}) =>
    data<SyncResponse>(await request(server).post('/api/fleet/runner/sync').set({ Authorization: `Bearer ${runner.apiKey}` }).send(syncBody(over)).expect(200));
  const dispatch = async (body: Record<string, unknown>) =>
    data<{ job: { id: string; state: string; leaseEpoch: number } }>(
      await request(server).post('/api/projects/web/fleet/jobs').set({ Authorization: `Bearer ${world.tokens.dev}` })
        .send({ repoId: world.repoId, maxCostUsd: 5, ...body }).expect(201),
    ).job;
  /** The App-API mints the forge received, oldest first. */
  const mints = () => forge.requests.filter((r) => r.method === 'POST' && r.path.endsWith('/access_tokens')).map((r) => r.body);

  beforeAll(async () => {
    forge = await startFakeForge();
    const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
    const keyFile = join(mkdtempSync(join(tmpdir(), 'gh-app-agent-')), 'app.pem');
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
    prisma = fixtureDb(app);
    world = await seedFleetHttpWorld(server, prisma);
    runner = await enrollRunner(server, world.tokens.root, 'box-agent', { capabilities: { ...FLEET_CAPS, agentsRun: true } });
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
  beforeEach(async () => {
    // Each case dispatches its own job: a job left ASSIGNED by the previous case would hold this runner's repo.
    await prisma.fleetCommand.deleteMany();
    await prisma.fleetJob.deleteMany();
    mint = vi.spyOn(app.get(GitTokenBroker), 'mint');
  });
  afterEach(() => {
    mint.mockRestore();
  });

  it('writes need an action context', async () => {
    await expect(expectGuardActive(app)).resolves.toBeUndefined();
  });

  it('AC-10: an ASSIGNED AGENT job default token request mints once with purpose read and grants a repo-less token', async () => {
    const job = await dispatch({ command: 'AGENT', feature: 'flow-a', agent: { name: 'spec-reviewer', task: 'x' } });
    expect(job.state).toBe('ASSIGNED');

    const res = await sync({ tokenRequests: [{ jobId: job.id, leaseEpoch: job.leaseEpoch }] });

    expect(mint).toHaveBeenCalledTimes(1);
    expect(mint.mock.calls[0]?.[0]).toEqual({
      jobId: job.id, leaseEpoch: job.leaseEpoch, repo: expect.objectContaining({ id: world.repoId }), purpose: 'read',
    });
    // The grant names no repository (a PROJECT read-only grant would) and is the read-only credential.
    expect(res.gitTokens).toEqual([{ jobId: job.id, token: 'ghs_brokered', username: 'x-access-token', expiresAt: expect.any(String) }]);
    expect(mints()).toEqual([{ repositories: [expect.any(String)], permissions: READ_ONLY_PERMISSIONS }]);
    // The credential lives only in the sync response (spec §7.1): no row holds it.
    const tables = await Promise.all([
      prisma.fleetCommand.findMany(), prisma.fleetActivity.findMany(), prisma.fleetJobEvent.findMany(), prisma.fleetJob.findMany(),
    ]);
    expect(JSON.stringify(tables, (_k, v) => (typeof v === 'bigint' ? v.toString() : v))).not.toContain('ghs_brokered');
  });

  it('AC-11: an ASSIGNED RUN job default token request mints with no purpose and keeps the write credential', async () => {
    const job = await dispatch({ command: 'RUN', feature: 'run-a' });
    const before = mints().length;

    const res = await sync({ tokenRequests: [{ jobId: job.id, leaseEpoch: job.leaseEpoch }] });

    expect(mint).toHaveBeenCalledTimes(1);
    expect(mint.mock.calls[0]?.[0]).toEqual({ jobId: job.id, leaseEpoch: job.leaseEpoch, repo: expect.objectContaining({ id: world.repoId }) });
    expect(Object.prototype.hasOwnProperty.call(mint.mock.calls[0]?.[0], 'purpose')).toBe(false);
    expect(res.gitTokens).toEqual([expect.objectContaining({ jobId: job.id, token: 'ghs_brokered' })]);
    const writeMint = mints().slice(before);
    expect(writeMint).toHaveLength(1);
    expect((writeMint[0] as { permissions: Record<string, string> }).permissions.contents).toBe('write');
  });
});
