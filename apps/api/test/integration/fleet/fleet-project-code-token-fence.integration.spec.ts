import { canRunDbTests } from '../../helpers/test-environment';
/**
 * Fleet S5b 1c-b — the repository read-only token fence end to end (PG + HTTP + the fake forge): a `repoId` token
 * request on a RUNNING PROJECT-session THREAD job mints a read-only token for a repository the ASSIGN would have
 * listed (US-002 AC-3/AC-4), and answers `repo_not_assigned` — minting nothing — for a repository of another project,
 * a GitLab repository, a repository without an installation, or a REPO thread (AC-5 and the 1c-b-D5 walk).
 *
 * There is no stored ASSIGN scope, so the fence recomputes it from the job row (`findThreadTokenScope`), the project's
 * repositories (`findProjectRepos`) and `fetchableProjectRepos`. This spec runs that walk against the database instead
 * of the stubs the unit spec uses.
 *
 * Run: cd apps/api && bun run test:db:up && bun run test:scoped test/integration/fleet/fleet-project-code-token-fence.integration.spec.ts
 */
import request from 'supertest';
import { generateKeyPairSync } from 'crypto';
import { mkdtempSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { NathApplication } from '@nathapp/nestjs-app';
import { Prisma, PrismaClient } from '../../../src/generated/prisma/client';
import { resetDb } from '../../helpers/reset-db';
import { bootHttpApp, data } from '../../helpers/http-app';
import { enrollRunner, FleetHttpWorld, seedFleetHttpWorld, syncBody } from '../../helpers/fleet-fixtures';
import { FakeForge, startFakeForge } from '../../helpers/fake-forge';
import type { SyncRequest, SyncResponse } from '../../../src/fleet/common/protocol';
import { expectGuardActive, fixtureDb } from '../../helpers/action-context';

// The nax sandbox withholds host Postgres/Docker.
const describeIntegration = canRunDbTests() ? describe : describe.skip;
const ENV_KEYS = ['GITHUB_API_URL', 'GITHUB_APP_ID', 'GITHUB_APP_PRIVATE_KEY_FILE', 'GITHUB_APP_SLUG', 'FLEET_SYNC_WAIT_MS'] as const;

describeIntegration('fleet project-code token fence (PG + HTTP, S5b 1c-b)', () => {
  let app: NathApplication;
  let server: ReturnType<NathApplication['getHttpServer']>;
  let prisma: PrismaClient;
  let world: FleetHttpWorld;
  let runner: { runnerId: string; apiKey: string };
  let forge: FakeForge;
  let seq = 0;
  const saved: Record<string, string | undefined> = {};

  const sync = async (over: Partial<SyncRequest> = {}) =>
    data<SyncResponse>(await request(server).post('/api/fleet/runner/sync').set({ Authorization: `Bearer ${runner.apiKey}` })
      .send(syncBody({ protocolVersion: 4, bootId: 'boot-1', freeSlots: 0, ...over })).expect(200));

  /** A RUNNING SESSION THREAD job of a PROJECT (or REPO) thread held by the enrolled runner at lease epoch 1. */
  const seedThreadJob = async (kind: 'PROJECT' | 'REPO') => {
    const feature = `pc-fence-${++seq}`;
    const thread = await prisma.chatThread.create({
      data: {
        projectId: world.projectId, kind,
        repoId: kind === 'PROJECT' ? null : world.repoId,
        baseRef: kind === 'PROJECT' ? null : 'trunk',
        feature: kind === 'PROJECT' ? null : feature,
        title: `fence ${feature}`, createdById: world.ids.dev, runnerId: runner.runnerId,
        backend: { kind: 'native', model: 'm1' }, skills: [],
        specPath: kind === 'PROJECT' ? null : `.nax/features/${feature}/spec.md`,
      },
    });
    const job = await prisma.fleetJob.create({
      data: {
        projectId: world.projectId, repoId: world.repoId, ref: 'trunk', command: 'THREAD', feature: `thread-${thread.id}`,
        profiles: [], selectorLabels: [], maxCostUsd: new Prisma.Decimal(5), requestedById: world.ids.dev,
        state: 'RUNNING', runnerId: runner.runnerId, leaseEpoch: 1, firstStartedAt: new Date(), threadId: thread.id,
      },
    });
    await prisma.fleetThreadTurn.create({
      data: { jobId: job.id, threadId: thread.id, action: 'SESSION', instructions: 'go', backend: { kind: 'native' }, skills: [], resume: false },
    });
    return job;
  };

  const requestFor = (jobId: string, repoId: string) => ({ jobId, leaseEpoch: 1, repoId });

  beforeAll(async () => {
    forge = await startFakeForge();
    const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
    const keyFile = join(mkdtempSync(join(tmpdir(), 'gh-pc-app-')), 'app.pem');
    writeFileSync(keyFile, privateKey.export({ type: 'pkcs1', format: 'pem' }));
    for (const key of ENV_KEYS) saved[key] = process.env[key];
    Object.assign(process.env, {
      GITHUB_API_URL: forge.url, GITHUB_APP_ID: '4242',
      GITHUB_APP_PRIVATE_KEY_FILE: keyFile, GITHUB_APP_SLUG: 'koda-fleet', FLEET_SYNC_WAIT_MS: '0',
    });
    // The read-only mint posts to the same endpoint as the write mint (1c-b-D3).
    forge.routes.set('POST /app/installations/77/access_tokens', () => ({
      status: 201, body: { token: 'ghs_read_only', expires_at: new Date(Date.now() + 60 * 60_000).toISOString() },
    }));

    await resetDb();
    app = await bootHttpApp({ registrationEnabled: false });
    server = app.getHttpServer();
    prisma = fixtureDb(app);
    world = await seedFleetHttpWorld(server, prisma);
    runner = await enrollRunner(server, world.tokens.root, 'pc-fence-runner');
    await prisma.runner.update({ where: { id: runner.runnerId }, data: { protocolVersion: 4, lastSeenAt: new Date(), enabled: true, capacity: 1 } });
  });
  afterAll(async () => {
    await app?.close();
    await forge.close();
    for (const key of ENV_KEYS) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
  });

  it('writes need an action context', async () => {
    await expect(expectGuardActive(app)).resolves.toBeUndefined();
  });

  it('US-002 AC-3/AC-4: mints a read-only token for a listed project repository, carrying its repoId', async () => {
    const job = await seedThreadJob('PROJECT');

    const res = await sync({ tokenRequests: [requestFor(job.id, world.repoId)] });

    expect(res.gitTokenErrors).toEqual([]);
    expect(res.gitTokens).toEqual([expect.objectContaining({
      jobId: job.id, repoId: world.repoId, token: 'ghs_read_only', username: 'x-access-token',
    })]);
  });

  it('US-002 AC-5: refuses another project’s repository and mints nothing', async () => {
    const job = await seedThreadJob('PROJECT');

    const res = await sync({ tokenRequests: [requestFor(job.id, world.foreignRepoId)] });

    expect(res.gitTokens).toEqual([]);
    expect(res.gitTokenErrors).toEqual([{ jobId: job.id, repoId: world.foreignRepoId, reason: 'repo_not_assigned' }]);
  });

  it('US-002 AC-5: refuses a GitLab repository and a GitHub repository with no installation', async () => {
    const job = await seedThreadJob('PROJECT');
    const unfetchable = (name: string, provider: string, githubInstallationId: bigint | null) =>
      prisma.fleetRepo.create({
        data: {
          projectId: world.projectId, provider, owner: 'acme', name, defaultBranch: 'main',
          githubInstallationId, createdById: world.ids.root,
        },
      });
    const gitlab = await unfetchable('pc-gitlab', 'gitlab', null);
    const noInstallation = await unfetchable('pc-no-installation', 'github', null);

    const res = await sync({ tokenRequests: [requestFor(job.id, gitlab.id), requestFor(job.id, noInstallation.id)] });

    expect(res.gitTokens).toEqual([]);
    expect(res.gitTokenErrors).toEqual([
      { jobId: job.id, repoId: gitlab.id, reason: 'repo_not_assigned' },
      { jobId: job.id, repoId: noInstallation.id, reason: 'repo_not_assigned' },
    ]);
  });

  it('US-002 AC-6: refuses a repoId request on a REPO thread’s SESSION job', async () => {
    const job = await seedThreadJob('REPO');

    const res = await sync({ tokenRequests: [requestFor(job.id, world.repoId)] });

    expect(res.gitTokens).toEqual([]);
    expect(res.gitTokenErrors).toEqual([{ jobId: job.id, repoId: world.repoId, reason: 'repo_not_assigned' }]);
  });

  it('never stores a brokered read-only token', async () => {
    const job = await seedThreadJob('PROJECT');
    await sync({ tokenRequests: [requestFor(job.id, world.repoId)] });

    const rows = await Promise.all([prisma.fleetJob.findMany(), prisma.fleetCommand.findMany(), prisma.fleetActivity.findMany(), prisma.fleetJobEvent.findMany()]);
    expect(JSON.stringify(rows, (_key, value) => (typeof value === 'bigint' ? value.toString() : value))).not.toContain('ghs_read_only');
  });
});
