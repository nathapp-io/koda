import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { PrismaClient } from '@prisma/client';
import type { ConfigFileEdit, SyncRequest } from '@nathapp/fleet-protocol';
import type { FakeForge } from '../../../../api/test/helpers/fake-forge';
import { createCapabilityProbe } from '../../../src/capabilities/create-probe';
import { enrollRunner } from '../../../src/commands/enroll';
import { loadRunnerConfig, resolveHome, type RunnerHome } from '../../../src/config/runner-config';
import { startDaemon, type DaemonHandle } from '../../../src/daemon/daemon';
import { readIdentity, type RunnerIdentityFile } from '../../../src/identity/identity-store';
import { createMemoryLogger, type MemoryLogger } from '../../../src/logger';
import { jobDirFor } from '../../../src/paths/safe-segment';
import { ServerClient } from '../../../src/sync/http';
import { systemNow } from '../../../src/time';
import { installFakeGh } from '../../helpers/fake-gh';
import type { GitHttpRequest } from '../../helpers/git-http';
import { git as sh, isolateGit, makeOrigin, type Origin } from '../../helpers/git-fixture';
import { startApi, type RunningApi } from './api-process';
import { assertPartialIndex, prepareDatabase, runnerTestDatabaseUrl } from './database';
import { startGitFront, type PushHold } from './git-front';
import { HARNESS_TOKEN, startForge, type Forge } from './forge';

const PASSWORD = 'Admin1234!Aa';
/** The admin `createWorld` registers; S2a slice 2's live check prints it for a manual look at the web viewer. */
export const HARNESS_ADMIN = { email: 'root@koda.test', password: PASSWORD } as const;
const FAKE_NAX = join(import.meta.dir, '..', '..', 'fixtures', 'fake-nax.ts');
const SELF = [process.execPath, join(import.meta.dir, '..', '..', '..', 'src', 'main.ts')];
export const FEATURES: readonly string[] = ['fa', 'fb', 'fc', 'fd', 'fe', 'ff', 'fg', 'fh', 'la', 'lb', 'lc', 'lv'];

export interface JobView {
  id: string; state: string; stateReason: string | null; leaseEpoch: number; runnerId: string | null;
  resultBranch: string | null; resultSha: string | null; resultPrUrl: string | null; finishResult: string | null;
  naxRunId: string | null; naxLogRunId: string | null; naxCostRunId: string | null; costSpentUsd: string;
  cancelRequestedAt: string | null; currentStoryId: string | null; wipPush: string | null;
  stories: unknown; storiesTruncated: boolean;
}
export interface EventView { seq: number; leaseEpoch: number; runnerSeq: number | null; type: string; payload: Record<string, unknown> }

/** One per sync request (D71): the seqs of the events it carried, and what the network did with it. */
export interface SyncRecord {
  readonly outcome: 'delivered' | 'dropped' | 'refused';
  readonly jobs: ReadonlyArray<{ readonly jobId: string; readonly seqs: readonly number[] }>;
}

/** `down` refuses before the request leaves; `dropResponse` performs the request and throws the response away. */
export interface NetControl {
  down: boolean;
  dropResponse: boolean;
  readonly syncs: SyncRecord[];
}

export interface TestRunner {
  readonly name: string;
  readonly home: RunnerHome;
  readonly net: NetControl;
  readonly log: MemoryLogger;
  daemon: DaemonHandle | null;
  start(): Promise<DaemonHandle>;
  stop(): Promise<void>;
  crash(): void;
  journalBytes(): Promise<Buffer>;
  jobDir(jobId: string): string;
  identity(): Promise<RunnerIdentityFile>;
}

export interface World {
  readonly base: string;
  /** The registered admin's access token (project `web`), for user routes such as the log reads (S2a slice 2). */
  readonly adminToken: string;
  /** The id of the registered origin repo (`acme/app` in project `web`). */
  readonly repoId: string;
  readonly api: RunningApi;
  readonly prisma: PrismaClient;
  readonly origin: Origin;
  readonly forge: FakeForge;
  readonly gitRequests: readonly GitHttpRequest[];
  readonly fakeGh: { binDir: string; logPath: string };
  readonly forgeCloneUrl: string;
  dispatch(input: { feature: string; command?: 'RUN' | 'PLAN'; ref?: string; planFrom?: string; profiles?: string[]; pinnedRunnerId?: string; bashMode?: 'raw' | 'gated' | 'escalate'; approvalTimeoutSec?: number }): Promise<string>;
  /** S3: a CONFIG_EDIT through the user route (Part B1). Returns the job id. */
  submitConfigEdit(input: { baseSha: string; edits: ConfigFileEdit[]; prTitle: string; prBody?: string }): Promise<string>;
  /** S3: a regenerate or drift job written straight to the database (placement picks it up on the next sync). */
  queueConfigJob(input: { command: 'CONFIG_EDIT' | 'CONFIG_DRIFT'; mode: 'regenerate' | 'drift'; prTitle?: string }): Promise<string>;
  configEdit(jobId: string): Promise<{ mode: string; result: unknown }>;
  job(id: string): Promise<JobView>;
  events(id: string): Promise<EventView[]>;
  waitForJob(id: string, predicate: (job: JobView) => boolean, timeoutMs?: number): Promise<JobView>;
  cancel(id: string): Promise<void>;
  approvals(jobId: string): Promise<Array<{ id: string; status: string; resolvedBy: string | null; outcome: Record<string, unknown> | null }>>;
  decide(approvalId: string, decision: 'allow' | 'allow_for_job' | 'deny'): Promise<number>;
  downloadBundle(id: string): Promise<{ status: number; bytes: Uint8Array }>;
  addRunner(name: string): Promise<TestRunner>;
  withFake<T>(env: Record<string, string>, fn: () => Promise<T>): Promise<T>;
  holdPushes(): PushHold;
  close(): Promise<void>;
}

const prd = (feature: string, story: string): string => `${JSON.stringify({ feature, branchName: `feat/${feature}`, userStories: [{ id: story, title: 'story' }] }, null, 2)}\n`;

type Cleanup = () => Promise<void>;

/** Reverse order, every step attempted: what a half-built world started must not outlive the failure (D73). */
async function unwind(cleanups: Cleanup[]): Promise<void> {
  for (const cleanup of [...cleanups].reverse()) await cleanup().catch(() => undefined);
}

export async function createWorld(): Promise<World> {
  const base = await mkdtemp(join(tmpdir(), 'koda-runner-it-'));
  const cleanups: Cleanup[] = [() => rm(base, { recursive: true, force: true })];
  try {
    return await buildWorld(base, cleanups);
  } catch (error) {
    await unwind(cleanups);
    throw error;
  }
}

async function buildWorld(base: string, cleanups: Cleanup[]): Promise<World> {
  isolateGit();
  const databaseUrl = runnerTestDatabaseUrl();
  await prepareDatabase(databaseUrl);
  const { forge, keyFile }: Forge = await startForge(join(base, 'forge'));
  cleanups.push(() => forge.close());
  const remotes = join(base, 'remotes');
  const front = startGitFront(forge.url, remotes, () => HARNESS_TOKEN);
  cleanups.push(async () => front.stop());
  const api = await startApi({
    DATABASE_URL: databaseUrl, JWT_SECRET: 'it-jwt-secret', JWT_REFRESH_SECRET: 'it-jwt-refresh-secret', API_KEY_SECRET: 'it-api-key-secret',
    RAG_IN_MEMORY_ONLY: 'true', EMBEDDING_PROVIDER: 'fake', REGISTRATION_ENABLED: 'true', AUTH_LOGIN_THROTTLE_LIMIT: '1000',
    FLEET_SYNC_WAIT_MS: '1500', FLEET_SWEEP_ENABLED: 'false', FLEET_ARTIFACT_DIR: join(base, 'artifacts'),
    VCS_ENCRYPTION_KEY: 'b'.repeat(64), GITHUB_APP_ID: '4242', GITHUB_APP_PRIVATE_KEY_FILE: keyFile, GITHUB_APP_SLUG: 'koda-fleet',
    GITHUB_API_URL: front.url, VCS_GITLAB_API_URL: `${front.url}/api/v4`,
  }, base);
  cleanups.push(() => api.stop());
  const prisma = new PrismaClient({ datasources: { db: { url: databaseUrl } } });
  cleanups.push(() => prisma.$disconnect());
  await assertPartialIndex(prisma);

  const http = async (method: string, path: string, opts: { body?: unknown; token?: string } = {}) => {
    const res = await fetch(`${api.url}/api${path}`, {
      method,
      headers: { 'content-type': 'application/json', ...(opts.token ? { authorization: `Bearer ${opts.token}` } : {}) },
      body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
    });
    const text = await res.text();
    return { status: res.status, body: text ? JSON.parse(text) : null };
  };
  const registered = await http('POST', '/auth/register', { body: { email: HARNESS_ADMIN.email, name: 'Root', password: PASSWORD } });
  if (registered.status !== 201) throw new Error(`register failed: ${JSON.stringify(registered.body)}`);
  const admin: string = registered.body.data.accessToken;
  await http('POST', '/projects', { token: admin, body: { name: 'Web', slug: 'web', key: 'WEB' } });
  const repo = await http('POST', '/fleet/repos', { token: admin, body: { projectSlug: 'web', provider: 'github', owner: 'acme', name: 'app' } });
  if (repo.status !== 201) throw new Error(`repo registration failed: ${JSON.stringify(repo.body)}\n${api.output()}`);
  const repoId: string = repo.body.data.id;

  const files: Record<string, string> = { 'README.md': '# app\n', 'docs/spec.md': '# spec\n', '.nax/config.json': '{}\n' };
  files['.nax/context.md'] = '# app context\n';   // S3: config jobs regenerate from it
  files['.nax/rules/a.md'] = '# rule a\n';
  for (const f of FEATURES) files[`.nax/features/${f}/prd.json`] = prd(f, f === 'fb' ? 'OLD-1' : 'US-001');
  // D104: a profile the repo provides (the fake nax reads <clone>/.nax/fake-profiles); the runners have no zai credential.
  files['.nax/fake-profiles/needs-zai.json'] = JSON.stringify({ fakeRequirements: { transport: 'native', providers: ['zai'], sandbox: false } });
  // #207: a profile the repo provides whose interaction plugin cannot start in the runner's environment.
  files['.nax/fake-profiles/broken-tg.json'] = JSON.stringify({ fakeInteraction: { plugin: 'telegram', status: 'failed', code: 'TELEGRAM_NOT_CONFIGURED' } });
  const origin = await makeOrigin(join(remotes, 'acme'), 'app', { files });
  const forgeCloneUrl = `${front.url}/acme/app.git`;
  process.env['FAKE_NAX_STEP_MS'] = '40';
  cleanups.push(async () => { for (const k of ['FAKE_NAX_STEP_MS']) delete process.env[k]; });

  const fakeGh = await installFakeGh(join(base, 'gh'));
  const savedPath = process.env['PATH'];
  process.env['PATH'] = `${fakeGh.binDir}${delimiter}${savedPath ?? ''}`;   // behind each job's shims (D88)
  process.env['FAKE_GH_LOG'] = fakeGh.logPath;
  cleanups.push(async () => { process.env['PATH'] = savedPath; delete process.env['FAKE_GH_LOG']; });

  const runners: TestRunner[] = [];
  const savedFake: Record<string, string | undefined> = {};

  // Polling reads the database: the API's global throttle is 100 requests a minute per IP and a 10 Hz poll would trip it.
  const job = async (id: string): Promise<JobView> => {
    const r = await prisma.fleetJob.findUniqueOrThrow({ where: { id } });
    return {
      id: r.id, state: r.state, stateReason: r.stateReason, leaseEpoch: r.leaseEpoch, runnerId: r.runnerId, resultBranch: r.resultBranch,
      resultSha: r.resultSha, resultPrUrl: r.resultPrUrl, finishResult: r.finishResult, naxRunId: r.naxRunId, naxLogRunId: r.naxLogRunId,
      naxCostRunId: r.naxCostRunId, costSpentUsd: r.costSpentUsd.toString(), cancelRequestedAt: r.cancelRequestedAt?.toISOString() ?? null,
      currentStoryId: r.currentStoryId, wipPush: r.wipPush, stories: r.stories, storiesTruncated: r.storiesTruncated,
    };
  };

  const world: World = {
    base, adminToken: admin, repoId, api, prisma, origin, forge, gitRequests: front.requests, holdPushes: () => front.holdPushes(), fakeGh, forgeCloneUrl,
    async submitConfigEdit(input) {
      const res = await http('POST', `/projects/web/fleet/repos/${repoId}/config-edits`, { token: admin, body: input });
      if (res.status !== 201) throw new Error(`config edit failed: ${JSON.stringify(res.body)}`);
      return res.body.data.job.id as string;   // Part B1 answers with DispatchResultDto, like dispatch
    },
    async queueConfigJob(input) {
      const [user, project] = await Promise.all([
        prisma.user.findUniqueOrThrow({ where: { email: HARNESS_ADMIN.email } }),
        prisma.project.findUniqueOrThrow({ where: { slug: 'web' } }),
      ]);
      const baseSha = await sh(origin.dir, 'rev-parse', 'main');
      // One transaction: placement must never see the job without its edit row.
      return prisma.$transaction(async (tx) => {
        const job = await tx.fleetJob.create({ data: {
          projectId: project.id, repoId, ref: 'main', command: input.command, feature: 'nax-config', profiles: [], maxCostUsd: 0,
          bashMode: 'raw', selectorLabels: [], requestedById: user.id,
        } });
        await tx.fleetConfigEdit.create({ data: { jobId: job.id, mode: input.mode, edits: [], prTitle: input.prTitle ?? null, prBody: null, baseSha } });
        return job.id;
      });
    },
    async configEdit(jobId) {
      const row = await prisma.fleetConfigEdit.findUniqueOrThrow({ where: { jobId } });
      return { mode: row.mode, result: row.result };
    },
    async dispatch(input) {
      const res = await http('POST', '/projects/web/fleet/jobs', {
        token: admin,
        body: { repoId, command: input.command ?? 'RUN', feature: input.feature, ...(input.ref ? { ref: input.ref } : {}), ...(input.planFrom ? { planFrom: input.planFrom } : {}), ...(input.profiles ? { profiles: input.profiles } : {}), ...(input.pinnedRunnerId ? { pinnedRunnerId: input.pinnedRunnerId } : {}), ...(input.bashMode ? { bashMode: input.bashMode } : {}), ...(input.approvalTimeoutSec ? { approvalTimeoutSec: input.approvalTimeoutSec } : {}), maxCostUsd: 5 },
      });
      if (res.status !== 201) throw new Error(`dispatch failed: ${JSON.stringify(res.body)}`);
      return res.body.data.job.id as string;
    },
    job,
    async events(id) {
      const rows = await prisma.fleetJobEvent.findMany({ where: { jobId: id }, orderBy: { seq: 'asc' } });
      return rows.map((e) => ({ seq: e.seq, leaseEpoch: e.leaseEpoch, runnerSeq: e.runnerSeq, type: e.type, payload: e.payload as Record<string, unknown> }));
    },
    async waitForJob(id, predicate, timeoutMs = 45_000) {
      const deadline = Date.now() + timeoutMs;
      let last = await job(id);
      while (!predicate(last)) {
        if (Date.now() > deadline) throw new Error(`timed out waiting for job ${id}; last view: ${JSON.stringify(last)}\nAPI tail:\n${api.output().slice(-1500)}`);
        await Bun.sleep(100);
        last = await job(id);
      }
      return last;
    },
    async cancel(id) {
      const res = await http('POST', `/projects/web/fleet/jobs/${id}/cancel`, { token: admin });
      if (res.status !== 200) throw new Error(`cancel failed: ${JSON.stringify(res.body)}`);
    },
    async approvals(jobId) {
      const res = await http('GET', `/fleet/approvals?jobId=${encodeURIComponent(jobId)}`, { token: admin });
      return (res.body as { data: { records: Array<{ id: string; status: string; resolvedBy: string | null; outcome: Record<string, unknown> | null }> } }).data.records;
    },
    async decide(approvalId, decision) {
      return (await http('POST', `/fleet/approvals/${approvalId}/decide`, { token: admin, body: { decision } })).status;
    },
    async downloadBundle(id) {
      const res = await fetch(`${api.url}/api/projects/web/fleet/jobs/${id}/bundle`, { headers: { authorization: `Bearer ${admin}` } });
      return { status: res.status, bytes: new Uint8Array(await res.arrayBuffer()) };
    },
    async addRunner(name) {
      const dir = await mkdtemp(join(base, `runner-${name}-`));
      const home = resolveHome({}, join(dir, 'home'));
      const workspaceRoot = join(dir, 'ws');
      await mkdir(home.dir, { recursive: true });
      const naxHome = join(dir, 'naxhome');
      await mkdir(join(naxHome, 'profiles'), { recursive: true });
      // D95, D108: no capabilities block, so the runner probes nax; the fake nax answers from these files.
      await writeFile(join(naxHome, 'profiles', 'fast.json'), JSON.stringify({ fakeRequirements: { transport: 'native', providers: ['deepseek'], sandbox: false } }));
      await writeFile(join(naxHome, 'fake-auth.json'), JSON.stringify({ providers: [{ providerId: 'deepseek', stored: { kind: 'api-key', expired: false }, ambient: false, available: true }] }));
      await writeFile(home.configPath, JSON.stringify({ serverUrl: api.url, workspaceRoot, naxHome, naxCommand: ['bun', FAKE_NAX], labels: ['harness'] }));
      const token: string = (await http('POST', '/fleet/enrollments', { token: admin, body: { labels: [] } })).body.data.token;
      await enrollRunner(
        { home, token, name, labels: [], insecureHttp: false },
        { env: {}, hostname: () => name, platform: process.platform, arch: process.arch, probe: (config) => createCapabilityProbe(config, systemNow), now: systemNow, makeClient: (serverUrl) => new ServerClient({ serverUrl }), log: () => undefined },
      );
      const net: NetControl = { down: false, dropResponse: false, syncs: [] };
      const log = createMemoryLogger();
      const runner: TestRunner = {
        name, home, net, log, daemon: null,
        async start() {
          const [config, identity] = [await loadRunnerConfig(home.configPath, {}), await readIdentity(home.identityPath)];
          if (!identity) throw new Error('runner is not enrolled');
          const fetchFn = async (url: string, init?: RequestInit): Promise<Response> => {
            const seen = recordSync(url, init);
            if (net.down) {
              if (seen) net.syncs.push({ outcome: 'refused', jobs: seen });
              throw new TypeError('network down');
            }
            const response = await fetch(url, init);
            if (net.dropResponse) {
              await response.arrayBuffer().catch(() => undefined);      // the server did its work; the runner never hears
              if (seen) net.syncs.push({ outcome: 'dropped', jobs: seen });
              throw new TypeError('response lost');
            }
            if (seen) net.syncs.push({ outcome: 'delivered', jobs: seen });
            return response;
          };
          await prisma.runner.update({ where: { name }, data: { enabled: true } });
          runner.daemon = await startDaemon({ home, config, identity, log, fetchFn, selfCommand: SELF, tuning: { statusPollMs: 50, syncMinGapMs: 20, ackPollMs: 25 } });
          return runner.daemon;
        },
        async stop() {
          await runner.daemon?.stop();
          // A stopped runner stays "online" for 90 s; disable it so placement never picks a daemon that is not there.
          await prisma.runner.update({ where: { name }, data: { enabled: false } }).catch(() => undefined);
        },
        crash() {
          runner.daemon?.crash();   // D40, D67: journal closed at once, nothing drained, no child signalled; the server is not told
        },
        async journalBytes() {
          const parts = await Promise.all(['', '-wal', '-shm'].map((suffix) => readFile(`${home.journalPath}${suffix}`).catch(() => Buffer.alloc(0))));
          return Buffer.concat(parts);
        },
        jobDir: (jobId) => jobDirFor(workspaceRoot, jobId),
        identity: async () => {
          const identity = await readIdentity(home.identityPath);
          if (!identity) throw new Error('runner is not enrolled');
          return identity;
        },
      };
      runners.push(runner);
      return runner;
    },
    async withFake(env, fn) {
      for (const [k, v] of Object.entries(env)) {
        savedFake[k] = process.env[k];
        process.env[k] = v;
      }
      try {
        return await fn();
      } finally {
        for (const k of Object.keys(env)) {
          if (savedFake[k] === undefined) delete process.env[k];
          else process.env[k] = savedFake[k];
        }
      }
    },
    async close() {
      await Promise.all(runners.map((r) => r.stop().catch(() => undefined)));
      await unwind(cleanups);
    },
  };
  return world;
}

/** The seqs a sync request carries, per job (D71); null for any other request. */
function recordSync(url: string, init?: RequestInit): SyncRecord['jobs'] | null {
  if (!url.endsWith('/fleet/runner/sync') || typeof init?.body !== 'string') return null;
  const body = JSON.parse(init.body) as SyncRequest;
  return body.jobs.map((job) => ({ jobId: job.jobId, seqs: job.events.map((event) => event.seq) }));
}
