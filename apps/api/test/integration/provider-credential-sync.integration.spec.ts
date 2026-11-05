import { canRunDbTests } from '../helpers/test-environment';
/**
 * US-006 — provider keys handed to runners through POST /fleet/runner/sync (PG).
 * Run: cd apps/api && bun run test:scoped test/integration/provider-credential-sync.integration.spec.ts
 */
import request from 'supertest';
import { NathApplication } from '@nathapp/nestjs-app';
import type { PrismaClient } from '../../src/generated/prisma/client';
import { resetDb } from '../helpers/reset-db';
import { bootHttpApp, data } from '../helpers/http-app';
import { enrollRunner, FleetHttpWorld, seedFleetHttpWorld, syncBody } from '../helpers/fleet-fixtures';
import { seedThreadJobFor } from '../helpers/thread-fixtures';
import type { SyncRequest, SyncResponse } from '../../src/fleet/common/protocol';
import { expectGuardActive, fixtureDb } from '../helpers/action-context';
import { LocalSecretStore } from '../../src/fleet/provider-credentials/secret-store';
import { scopeKeyFor, type ProviderCredentialScope } from '../../src/fleet/provider-credentials/provider-credential.domain';
import { PROVIDER_CREDENTIALS_CFG, type IProviderCredentialsConfig } from '../../src/config/provider-credentials.config';
import { FLEET_CFG, type IFleetConfig } from '../../src/config/fleet.config';

// The nax sandbox withholds host Postgres/Docker.
const describeIntegration = canRunDbTests() ? describe : describe.skip;

const ENV_KEY = 'PROVIDER_CREDENTIAL_ENCRYPTION_KEY';
const ENV_WAIT = 'FLEET_SYNC_WAIT_MS';
/** A 64-hex-char master key: the vault's only accepted shape. */
const MASTER_KEY = 'a1b2c3d4'.repeat(8);
const LEASE_MS = 10 * 60_000;

describeIntegration('provider credential sync hand-out (PG)', () => {
  let app: NathApplication;
  let server: ReturnType<NathApplication['getHttpServer']>;
  let prisma: PrismaClient;
  let store: LocalSecretStore;
  let world: FleetHttpWorld;
  let runner: { runnerId: string; apiKey: string };
  const saved: Record<string, string | undefined> = {};

  const sync = async (over: Partial<SyncRequest> = {}) =>
    data<SyncResponse>(await request(server).post('/api/fleet/runner/sync')
      .set({ Authorization: `Bearer ${runner.apiKey}` }).send(syncBody(over)).expect(200));
  const asDev = () => ({ Authorization: `Bearer ${world.tokens.dev}` });
  const job = (id: string) => prisma.fleetJob.findUniqueOrThrow({ where: { id } });
  const dispatch = async (feature: string) =>
    data<{ job: { id: string; leaseEpoch: number } }>(
      await request(server).post('/api/projects/web/fleet/jobs').set(asDev())
        .send({ repoId: world.repoId, command: 'RUN', maxCostUsd: 5, feature }).expect(201),
    ).job;

  /** Dispatch, take the ASSIGN, ack it and report RUNNING: a held job with a clean command queue. */
  const startRunning = async (feature: string) => {
    const j = await dispatch(feature);
    const assign = (await sync()).commands.find((c) => c.jobId === j.id && c.type === 'ASSIGN');
    if (assign === undefined) throw new Error(`no ASSIGN delivered for job ${j.id}`);
    await sync({
      commandAcks: [{ commandId: assign.commandId, leaseEpoch: j.leaseEpoch, result: 'ok' }],
      jobs: [{ jobId: j.id, leaseEpoch: j.leaseEpoch, events: [{ seq: 1, type: 'state', payload: { to: 'RUNNING' } }] }],
    });
    return j;
  };

  /** One sealed credential row, written straight into PG (management routes belong to US-003/US-005). */
  const createCredential = async (opts: {
    scope: ProviderCredentialScope;
    name: string;
    key: string;
    providerId?: string;
    projectId?: string | null;
    repoId?: string | null;
    encryptedKey?: string;
  }) => {
    const sealed = store.seal(opts.key);
    const projectId = opts.projectId ?? null;
    const repoId = opts.repoId ?? null;
    return prisma.providerCredential.create({
      data: {
        scope: opts.scope,
        scopeKey: scopeKeyFor({ scope: opts.scope, projectId, repoId }),
        projectId,
        repoId,
        providerId: opts.providerId ?? 'openrouter',
        name: opts.name,
        encryptedKey: opts.encryptedKey ?? sealed.encryptedKey,
        last4: sealed.last4,
        fingerprint: sealed.fingerprint,
        createdById: world.ids.root,
        updatedById: world.ids.root,
      },
    });
  };
  const requestKey = (jobId: string, leaseEpoch: number, providerId = 'openrouter') => ({ jobId, leaseEpoch, providerId });
  const issuedRows = (jobId: string) => prisma.fleetActivity.findMany({ where: { jobId, action: 'credential.issued' } });

  beforeAll(async () => {
    saved[ENV_KEY] = process.env[ENV_KEY];
    saved[ENV_WAIT] = process.env[ENV_WAIT];
    process.env[ENV_KEY] = MASTER_KEY;
    process.env[ENV_WAIT] = '0';
    await resetDb();
    app = await bootHttpApp({ registrationEnabled: false });
    server = app.getHttpServer();
    prisma = fixtureDb(app);
    store = app.get(LocalSecretStore, { strict: false });
    world = await seedFleetHttpWorld(server, prisma);
    runner = await enrollRunner(server, world.tokens.root, 'vault-box');
  }, 60_000);

  afterAll(async () => {
    await app?.close();
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  afterEach(async () => {
    await prisma.providerCredentialIssue.deleteMany();
    await prisma.providerCredential.deleteMany();
    await prisma.fleetActivity.deleteMany({ where: { action: 'credential.issued' } });
    await prisma.fleetJob.updateMany({
      where: { state: { in: ['ASSIGNED', 'RUNNING', 'UPLOADING'] } },
      data: { state: 'COMPLETED' },
    });
  });

  it('writes need an action context', async () => {
    await expect(expectGuardActive(app)).resolves.toBeUndefined();
  });

  it('AC-1: grants the plaintext key of the active GLOBAL credential to a RUNNING job', async () => {
    const j = await startRunning('vault-grant');
    await createCredential({ scope: 'GLOBAL', name: 'fleet', key: 'sk-or-abcdef123456' });

    const response = await sync({ providerRequests: [requestKey(j.id, j.leaseEpoch)] });

    expect(response.providerKeys).toHaveLength(1);
    expect(response.providerKeys[0]).toMatchObject({ jobId: j.id, providerId: 'openrouter', key: 'sk-or-abcdef123456' });
    expect(response.providerKeyErrors).toEqual([]);
  });

  it('AC-2: carries account koda:global:fleet and the credential fingerprint', async () => {
    const j = await startRunning('vault-account');
    const credential = await createCredential({ scope: 'GLOBAL', name: 'fleet', key: 'sk-or-abcdef123456' });

    const response = await sync({ providerRequests: [requestKey(j.id, j.leaseEpoch)] });

    expect(response.providerKeys[0]).toMatchObject({ account: 'koda:global:fleet', fingerprint: credential.fingerprint });
    expect(response.providerKeys[0].fingerprint).toMatch(/^[0-9a-f]{12}$/);
  });

  it('AC-3: expires the lease ten minutes after the sync time', async () => {
    const j = await startRunning('vault-expiry');
    await createCredential({ scope: 'GLOBAL', name: 'fleet', key: 'sk-or-abcdef123456' });

    const before = Date.now();
    const response = await sync({ providerRequests: [requestKey(j.id, j.leaseEpoch)] });
    const after = Date.now();

    const expiresAt = Date.parse(response.providerKeys[0].expiresAt);
    expect(expiresAt).toBeGreaterThanOrEqual(before + LEASE_MS);
    expect(expiresAt).toBeLessThanOrEqual(after + LEASE_MS);
  });

  it('AC-4: answers none when no key resolves, and when the resolved ciphertext cannot be decrypted', async () => {
    const j = await startRunning('vault-none');

    const missing = await sync({ providerRequests: [requestKey(j.id, j.leaseEpoch)] });
    expect(missing.providerKeys).toEqual([]);
    expect(missing.providerKeyErrors).toEqual([{ jobId: j.id, providerId: 'openrouter', reason: 'none' }]);

    await createCredential({ scope: 'GLOBAL', name: 'broken', key: 'sk-broken-abcdef123456', encryptedKey: 'aa:bb:cc' });
    const undecryptable = await sync({ providerRequests: [requestKey(j.id, j.leaseEpoch)] });
    expect(undecryptable.providerKeys).toEqual([]);
    expect(undecryptable.providerKeyErrors).toEqual([{ jobId: j.id, providerId: 'openrouter', reason: 'none' }]);
  });

  it('AC-5: answers job_not_active for a job the runner no longer holds in a held state', async () => {
    const j = await startRunning('vault-inactive');
    await createCredential({ scope: 'GLOBAL', name: 'fleet', key: 'sk-or-abcdef123456' });
    await prisma.fleetJob.update({ where: { id: j.id }, data: { state: 'COMPLETED' } });

    const response = await sync({ providerRequests: [requestKey(j.id, j.leaseEpoch)] });

    expect(response.providerKeys).toEqual([]);
    expect(response.providerKeyErrors).toEqual([{ jobId: j.id, providerId: 'openrouter', reason: 'job_not_active' }]);
  });

  it('AC-6: grants nothing for a stale lease epoch', async () => {
    const j = await startRunning('vault-stale-none');
    await createCredential({ scope: 'GLOBAL', name: 'fleet', key: 'sk-or-abcdef123456' });

    const response = await sync({ providerRequests: [requestKey(j.id, j.leaseEpoch + 5)] });

    expect(response.providerKeys).toEqual([]);
    expect(response.providerKeyErrors).toEqual([]);
  });

  it('AC-7: queues one ABANDON for the requesting runner/job/epoch and leaves the job state alone', async () => {
    const j = await startRunning('vault-stale-abandon');
    await createCredential({ scope: 'GLOBAL', name: 'fleet', key: 'sk-or-abcdef123456' });

    await sync({ providerRequests: [requestKey(j.id, j.leaseEpoch + 5)] });
    await sync({ providerRequests: [requestKey(j.id, j.leaseEpoch + 5)] });

    const abandons = await prisma.fleetCommand.findMany({ where: { jobId: j.id, type: 'ABANDON' } });
    expect(abandons).toHaveLength(1);
    expect(abandons[0]).toMatchObject({ runnerId: runner.runnerId, jobId: j.id, leaseEpoch: j.leaseEpoch + 5, payload: { reason: 'stale_lease' } });
    expect(await job(j.id)).toMatchObject({ state: 'RUNNING', leaseEpoch: j.leaseEpoch });
  });

  it('AC-8: answers vault_off with the master key unset', async () => {
    const j = await startRunning('vault-off');
    await createCredential({ scope: 'GLOBAL', name: 'fleet', key: 'sk-or-abcdef123456' });
    const config = app.get<IProviderCredentialsConfig>(PROVIDER_CREDENTIALS_CFG);
    const savedKey = config.encryptionKey;
    config.encryptionKey = undefined;
    try {
      const response = await sync({ providerRequests: [requestKey(j.id, j.leaseEpoch)] });

      expect(response.providerKeys).toEqual([]);
      expect(response.providerKeyErrors).toEqual([{ jobId: j.id, providerId: 'openrouter', reason: 'vault_off' }]);
    } finally {
      config.encryptionKey = savedKey;
    }
  });

  it('AC-9: grants a REPO thread job the REPO key of the thread repoId', async () => {
    const seeded = await seedThreadJobFor(prisma, world, runner, { kind: 'REPO' });
    await createCredential({ scope: 'GLOBAL', name: 'global', key: 'sk-global-abcdef123456' });
    await createCredential({ scope: 'PROJECT', projectId: world.projectId, name: 'project', key: 'sk-project-abcdef123456' });
    await createCredential({ scope: 'REPO', projectId: world.projectId, repoId: world.repoId, name: 'repo', key: 'sk-repo-abcdef123456' });

    const response = await sync({ providerRequests: [requestKey(seeded.jobId, 1)] });

    expect(response.providerKeyErrors).toEqual([]);
    expect(response.providerKeys).toHaveLength(1);
    expect(response.providerKeys[0]).toMatchObject({ jobId: seeded.jobId, key: 'sk-repo-abcdef123456', account: 'koda:repo:repo' });
  });

  it('AC-10: grants a PROJECT thread job the PROJECT key even when a REPO key exists for its repo', async () => {
    const seeded = await seedThreadJobFor(prisma, world, runner, { kind: 'PROJECT' });
    await createCredential({ scope: 'REPO', projectId: world.projectId, repoId: world.repoId, name: 'repo', key: 'sk-repo-abcdef123456' });
    await createCredential({ scope: 'PROJECT', projectId: world.projectId, name: 'project', key: 'sk-project-abcdef123456' });

    const response = await sync({ providerRequests: [requestKey(seeded.jobId, 1)] });

    expect(response.providerKeys).toHaveLength(1);
    expect(response.providerKeys[0]).toMatchObject({ key: 'sk-project-abcdef123456', account: 'koda:project:project' });
  });

  it('AC-11: grants a WORKSPACE thread job the PROJECT key of the thread projectId', async () => {
    const seeded = await seedThreadJobFor(prisma, world, runner, { kind: 'WORKSPACE' });
    await createCredential({ scope: 'PROJECT', projectId: world.projectId, name: 'project', key: 'sk-project-abcdef123456' });
    await createCredential({ scope: 'GLOBAL', name: 'global', key: 'sk-global-abcdef123456' });

    const response = await sync({ providerRequests: [requestKey(seeded.jobId, 1)] });

    expect(response.providerKeys).toHaveLength(1);
    expect(response.providerKeys[0]).toMatchObject({ key: 'sk-project-abcdef123456', account: 'koda:project:project' });
  });

  it('AC-12: records one credential.issued row for the job with actor RUNNER and the metadata payload', async () => {
    const j = await startRunning('vault-issued');
    const credential = await createCredential({ scope: 'GLOBAL', name: 'fleet', key: 'sk-or-abcdef123456' });

    await sync({ providerRequests: [requestKey(j.id, j.leaseEpoch)] });

    const rows = await issuedRows(j.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      actorType: 'RUNNER', actorId: runner.runnerId, action: 'credential.issued',
      entityType: 'provider_credential', entityId: credential.id, jobId: j.id, projectId: world.projectId,
      payload: { providerId: 'openrouter', scope: 'GLOBAL', name: 'fleet', fingerprint: credential.fingerprint },
    });
    expect(await prisma.providerCredentialIssue.count({ where: { jobId: j.id } })).toBe(1);
  });

  it('AC-13: records no second credential.issued row for the same credential and fingerprint', async () => {
    const j = await startRunning('vault-dedupe');
    await createCredential({ scope: 'GLOBAL', name: 'fleet', key: 'sk-or-abcdef123456' });

    const first = await sync({ providerRequests: [requestKey(j.id, j.leaseEpoch)] });
    const second = await sync({ providerRequests: [requestKey(j.id, j.leaseEpoch)] });

    expect(first.providerKeys).toHaveLength(1);
    expect(second.providerKeys).toHaveLength(1);
    expect(await issuedRows(j.id)).toHaveLength(1);
    expect(await prisma.providerCredentialIssue.count({ where: { jobId: j.id } })).toBe(1);
  });

  it('AC-14: returns without waiting for the long poll when the only content is a provider grant', async () => {
    const j = await startRunning('vault-idle');
    await createCredential({ scope: 'GLOBAL', name: 'fleet', key: 'sk-or-abcdef123456' });
    const fleet = app.get<IFleetConfig>(FLEET_CFG, { strict: false });
    const savedWait = fleet.syncWaitMs;
    fleet.syncWaitMs = 2_000;
    try {
      const started = Date.now();
      const response = await sync({ providerRequests: [requestKey(j.id, j.leaseEpoch)] });

      expect(response.providerKeys).toHaveLength(1);
      expect(Date.now() - started).toBeLessThan(1_000);
    } finally {
      fleet.syncWaitMs = savedWait;
    }
  });
});
