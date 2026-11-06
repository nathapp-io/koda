import { canRunDbTests } from '../../helpers/test-environment';
/**
 * US-005 AC-10/AC-11 — a held AGENT job's default token request gets the read purpose (PG, real broker + fake forge).
 * Run: cd apps/api && bun run test:scoped test/integration/fleet/runner-agent-token.integration.spec.ts
 *
 * The world is seeded with rows (project, repo, runner, ASSIGNED job) and the real `SyncService` is driven directly,
 * so the case depends on nothing but the database state it writes itself: no registration bootstrap, no enrollment
 * handshake and no dispatch — each of those is another stateful step that fails in `beforeAll` (with nothing
 * structured to report) whenever the shared test database moves under the run.
 */
import { generateKeyPairSync } from 'crypto';
import { mkdtempSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { NathApplication } from '@nathapp/nestjs-app';
import { Prisma, PrismaClient } from '../../../src/generated/prisma/client';
import { resetDb } from '../../helpers/reset-db';
import { bootHttpApp } from '../../helpers/http-app';
import { insertRunner, seedFleetBase, FLEET_CAPS } from '../../helpers/fleet-fixtures';
import { FakeForge, startFakeForge } from '../../helpers/fake-forge';
import type { SyncRequest, SyncResponse } from '../../../src/fleet/common/protocol';
import { GitTokenBroker } from '../../../src/fleet/git-broker/git-token.broker';
import { SyncService } from '../../../src/fleet/sync/sync.service';
import { expectGuardActive, fixtureDb, withTestActor } from '../../helpers/action-context';

// The nax sandbox withholds host Postgres/Docker.
const describeIntegration = canRunDbTests() ? describe : describe.skip;
const ENV_KEYS = ['GITHUB_API_URL', 'GITHUB_APP_ID', 'GITHUB_APP_PRIVATE_KEY_FILE', 'GITHUB_APP_SLUG'] as const;

/** The permissions a mint asked the App API for. */
const READ_ONLY_PERMISSIONS = { contents: 'read', metadata: 'read' };

/** A sync with no work of its own; each case adds the one token request it is about. */
const SYNC_BASE: Omit<SyncRequest, 'tokenRequests'> = {
  protocolVersion: 1, bootId: 'boot-1', daemonVersion: '0.1.0', freeSlots: 0, jobs: [], commandAcks: [],
};

describeIntegration('AGENT read-only token on sync (PG)', () => {
  let app: NathApplication;
  let prisma: PrismaClient;
  let base: Awaited<ReturnType<typeof seedFleetBase>>;
  let runner: { id: string };
  let syncService: SyncService;
  let forge: FakeForge;
  let mint: ReturnType<typeof vi.spyOn>;
  const saved: Record<string, string | undefined> = {};
  const savedWait = process.env.FLEET_SYNC_WAIT_MS;

  /** One ASSIGNED job of the given command, held by the seeded runner on lease epoch 1. */
  const assignedJob = (command: 'AGENT' | 'RUN', feature: string) => prisma.fleetJob.create({
    data: {
      projectId: base.projectId, repoId: base.repoId, ref: 'main', command, feature, profiles: [],
      maxCostUsd: new Prisma.Decimal(5), selectorLabels: [], requestedById: base.adminId,
      state: 'ASSIGNED', runnerId: runner.id, leaseEpoch: 1, assignedAt: new Date(),
      ...(command === 'AGENT' ? { agentInput: { name: 'spec-reviewer', task: 'x' } } : {}),
    },
  });
  /** The runner's own sync, as its daemon sends it. */
  const sync = (over: Partial<SyncRequest> = {}): Promise<SyncResponse> =>
    withTestActor({ type: 'RUNNER', id: runner.id }, () => syncService.sync(runner.id, { ...SYNC_BASE, ...over }));
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
    app = await bootHttpApp({ registrationEnabled: false, ownerEmail: null });
    prisma = fixtureDb(app);
    syncService = app.get(SyncService);
    base = await seedFleetBase(prisma);
    // The AGENT job's runner: it reports the capability the job needs (US-007 ships the probe).
    runner = await insertRunner(prisma, { capabilities: { ...FLEET_CAPS, agentsRun: true } });
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
    // The fake forge outlives the cases, so its request history is cleared too: a case that asserts on the mints it
    // caused must not see a previous case's mint (vitest may run them in any order).
    forge.requests.length = 0;
    mint = vi.spyOn(app.get(GitTokenBroker), 'mint');
  });
  afterEach(() => {
    mint.mockRestore();
  });

  it('writes need an action context', async () => {
    await expect(expectGuardActive(app)).resolves.toBeUndefined();
  });

  it('AC-10: an ASSIGNED AGENT job default token request mints once with purpose read and grants a repo-less token', async () => {
    const job = await assignedJob('AGENT', 'flow-a');
    const before = mints().length;

    const res = await sync({ tokenRequests: [{ jobId: job.id, leaseEpoch: job.leaseEpoch }] });

    expect(mint).toHaveBeenCalledTimes(1);
    expect(mint.mock.calls[0]?.[0]).toEqual({
      jobId: job.id, leaseEpoch: job.leaseEpoch, repo: expect.objectContaining({ id: base.repoId }), purpose: 'read',
    });
    // The grant names no repository (a PROJECT read-only grant would) and is the read-only credential.
    expect(res.gitTokens).toEqual([{ jobId: job.id, token: 'ghs_brokered', username: 'x-access-token', expiresAt: expect.any(String) }]);
    // Only the mint this case caused: a shared forge history must not decide the assertion.
    expect(mints().slice(before)).toEqual([{ repositories: [expect.any(String)], permissions: READ_ONLY_PERMISSIONS }]);
    // The credential lives only in the sync response (spec §7.1): no row holds it.
    const tables = await Promise.all([
      prisma.fleetCommand.findMany(), prisma.fleetActivity.findMany(), prisma.fleetJobEvent.findMany(), prisma.fleetJob.findMany(),
    ]);
    expect(JSON.stringify(tables, (_k, v) => (typeof v === 'bigint' ? v.toString() : v))).not.toContain('ghs_brokered');
  });

  it('AC-11: an ASSIGNED RUN job default token request mints with no purpose and keeps the write credential', async () => {
    const job = await assignedJob('RUN', 'run-a');
    const before = mints().length;

    const res = await sync({ tokenRequests: [{ jobId: job.id, leaseEpoch: job.leaseEpoch }] });

    expect(mint).toHaveBeenCalledTimes(1);
    expect(mint.mock.calls[0]?.[0]).toEqual({ jobId: job.id, leaseEpoch: job.leaseEpoch, repo: expect.objectContaining({ id: base.repoId }) });
    expect(Object.prototype.hasOwnProperty.call(mint.mock.calls[0]?.[0], 'purpose')).toBe(false);
    expect(res.gitTokens).toEqual([expect.objectContaining({ jobId: job.id, token: 'ghs_brokered' })]);
    const writeMint = mints().slice(before);
    expect(writeMint).toHaveLength(1);
    expect((writeMint[0] as { permissions: Record<string, string> }).permissions.contents).toBe('write');
  });
});
