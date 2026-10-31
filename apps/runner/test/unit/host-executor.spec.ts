import { afterAll, beforeAll, describe, expect, mock, test } from 'bun:test';
import { mkdirSync, rmSync } from 'node:fs';
import { copyFile, mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { AssignPayload } from '@nathapp/fleet-protocol';
import type { SnapshotEventPayload } from '@nathapp/fleet-protocol';
import type { ApprovalRelay } from '../../src/approvals/approval-relay';
import type { CredentialProvider } from '../../src/credentials/broker';
import { HostExecutor } from '../../src/executor/host-executor';
import { createGit } from '../../src/executor/git';
import { configBranchName } from '../../src/executor/config-job/commit-push';
import { jobProfileName, jobProfilePath } from '../../src/executor/job-profile';
import type { SpawnHandle } from '../../src/executor/job-executor';
import { isProcessAlive, type SpawnNaxOptions } from '../../src/executor/nax-process';
import type { ProcessInfo } from '../../src/executor/pid-registry';
import { REVIEW_TOKEN_FILE, writeReviewToken } from '../../src/executor/review-token';
import { Journal } from '../../src/journal/journal';
import type { JobRow } from '../../src/journal/types';
import { createMemoryLogger } from '../../src/logger';
import { jobDirFor } from '../../src/paths/safe-segment';
import { runVerdict } from '../../src/verdict/run-verdict';
import { git as sh, isolateGit, makeOrigin } from '../helpers/git-fixture';
import { NO_APPROVALS } from '../helpers/no-approvals';
import { NO_CREDENTIALS } from '../helpers/no-credentials';
import { makeTempDirs } from '../helpers/tmp';
import { waitFor } from '../helpers/wait';

const tmp = makeTempDirs();
const FAKE = join(import.meta.dir, '..', 'fixtures', 'fake-nax.ts');
const PRD = JSON.stringify({ branchName: 'feat/feat', userStories: [{ id: 'OLD-1' }] });
beforeAll(() => { isolateGit(); process.env['FAKE_NAX_STEP_MS'] = '10'; });
afterAll(() => { delete process.env['FAKE_NAX_STEP_MS']; delete process.env['FAKE_NAX_SCENARIO']; return tmp.cleanup(); });

/** A `ProcessInfo` with no processes: `ps` is never spawned (nax#2520). Tests override the lookups they need. */
const NO_PROCESSES: ProcessInfo = { start: async () => null, command: async () => null };

async function world(command: 'RUN' | 'PLAN' | 'REVIEW' = 'RUN', over: Partial<AssignPayload> = {}, extraFiles: Record<string, string> = {}, approvals: Pick<ApprovalRelay, 'open' | 'close' | 'resume'> = NO_APPROVALS, processInfo: ProcessInfo = NO_PROCESSES) {
  const base = await tmp.make('host');
  const origin = await makeOrigin(base, 'origin', { files: { 'README.md': 'x', 'docs/spec.md': '# spec from repo\n', '.nax/features/feat/prd.json': PRD, ...extraFiles } });
  const workspaceRoot = join(base, 'ws');
  const naxHome = join(base, 'naxhome');
  const assign: AssignPayload = {
    jobId: 'cjob1', command, repo: { provider: 'github', owner: 'acme', name: 'app', defaultBranch: 'main', cloneUrl: origin.url },
    ref: 'main', feature: 'feat', planFrom: command === 'PLAN' ? 'docs/spec.md' : null, profiles: [], maxCostUsd: '5', bashMode: 'raw', approvalTimeoutSec: 600,
    gitIdentity: { name: 'koda-fleet[bot]', email: 'bot@x' }, ...over,
  };
  const journal = Journal.open(':memory:');
  const row: JobRow = journal.insertJob({ assign, leaseEpoch: 1, repoKey: 'acme/app', jobDir: jobDirFor(workspaceRoot, assign.jobId) }).row;
  const log = createMemoryLogger();
  const ex = new HostExecutor({ config: { workspaceRoot, naxCommand: ['bun', FAKE], naxHome }, git: createGit(), log, nowMs: () => Date.now(), sleep: async () => undefined, credentials: NO_CREDENTIALS, approvals, processInfo });
  return { base, origin, workspaceRoot, naxHome, assign, row, ex, journal, log };
}

describe('HostExecutor review verdict (US-007)', () => {
  test('reads the posted marker from <jobDir>/nax.stdout', async () => {
    const w = await world('REVIEW');
    await mkdir(w.row.jobDir, { recursive: true });
    await writeFile(join(w.row.jobDir, 'nax.stdout'), 'nax bot review: artifact /out/bot/pr-42/r1/bot-review.json\n');
    expect(await w.ex.readReviewPosted(w.row)).toBe(true);
  });
});

describe('HostExecutor process lookups are injected (US-001)', () => {
  /** A registry entry for this job's clone, written where `reap` reads it. */
  async function registerPid(w: { workspaceRoot: string }, pid: number, registered: Date): Promise<void> {
    const repoDir = join(w.workspaceRoot, 'acme', 'app');
    await mkdir(repoDir, { recursive: true });
    await writeFile(join(repoDir, '.nax-pids'), `${JSON.stringify({ pid, spawnedAt: registered.toISOString(), workdir: repoDir })}\n`);
  }

  test('AC-1: matchesProcess for a RUN job calls the injected command with its pid and matches its profile', async () => {
    const pids: number[] = [];
    const processInfo: ProcessInfo = {
      start: async () => null,
      command: async (pid) => { pids.push(pid); return `nax run --headless --profile ${jobProfileName('cjob1')}`; },
    };
    const w = await world('RUN', {}, {}, NO_APPROVALS, processInfo);
    expect(await w.ex.matchesProcess({ ...w.row, pid: 4242, pgid: 4242 })).toBe(true);
    expect(pids).toEqual([4242]);
  });

  test('AC-2: matchesProcess for a RUN job is false when the command is the profile of another job', async () => {
    const processInfo: ProcessInfo = { start: async () => null, command: async () => 'nax run --profile koda-job-other' };
    const w = await world('RUN', {}, {}, NO_APPROVALS, processInfo);
    expect(await w.ex.matchesProcess({ ...w.row, pid: 4242, pgid: 4242 })).toBe(false);
  });

  test('AC-3: matchesProcess is false when the injected command is null', async () => {
    const processInfo: ProcessInfo = { start: async () => null, command: async () => null };
    const w = await world('RUN', {}, {}, NO_APPROVALS, processInfo);
    expect(await w.ex.matchesProcess({ ...w.row, pid: 4242, pgid: 4242 })).toBe(false);
  });

  test('AC-4: matchesProcess for a null pid is false without calling the injected command', async () => {
    let calls = 0;
    const processInfo: ProcessInfo = { start: async () => null, command: async () => { calls += 1; return 'anything'; } };
    const w = await world('RUN', {}, {}, NO_APPROVALS, processInfo);
    expect(await w.ex.matchesProcess({ ...w.row, pid: null, pgid: null })).toBe(false);
    expect(calls).toBe(0);
  });

  test('AC-5: matchesProcess for a CONFIG_EDIT job matches its clone directory or its config branch', async () => {
    let commandLine = '';
    const processInfo: ProcessInfo = { start: async () => null, command: async () => commandLine };
    const w = await world('RUN', {}, {}, NO_APPROVALS, processInfo);
    const cloneDir = join(w.workspaceRoot, 'acme', 'app');
    const config = { ...w.row, command: 'CONFIG_EDIT' as const, pid: 4242, pgid: 4242 };

    commandLine = `nax config -d ${cloneDir}`;
    expect(await w.ex.matchesProcess(config)).toBe(true);

    commandLine = `gh pr create --head ${configBranchName('cjob1')}`;
    expect(await w.ex.matchesProcess(config)).toBe(true);

    commandLine = `nax run --profile ${jobProfileName('cjob1')}`;
    expect(await w.ex.matchesProcess(config)).toBe(false);
  });

  test('AC-6: reap calls the injected start lookup with the pid registered for the job clone', async () => {
    const started: number[] = [];
    const processInfo: ProcessInfo = { start: async (pid) => { started.push(pid); return null; }, command: async () => null };
    const w = await world('RUN', {}, {}, NO_APPROVALS, processInfo);
    const registered = new Date();
    await registerPid(w, 5151, registered);
    await w.ex.reap(w.row, new Date(registered.getTime() - 60_000));
    expect(started).toEqual([5151]);
  });

  test('AC-7: reap does not kill a registered pid whose injected start lookup returns null', async () => {
    const child = Bun.spawn(['sleep', '60'], { stdout: 'ignore', stderr: 'ignore' });
    try {
      const processInfo: ProcessInfo = { start: async () => null, command: async () => null };
      const w = await world('RUN', {}, {}, NO_APPROVALS, processInfo);
      const registered = new Date();
      await registerPid(w, child.pid, registered);
      await w.ex.reap(w.row, new Date(registered.getTime() - 60_000));
      expect(isProcessAlive(child.pid)).toBe(true);
    } finally {
      child.kill();
    }
  });

  test('AC-8: reap kills a registered child whose injected start lookup returns its registration time', async () => {
    const child = Bun.spawn(['sleep', '60'], { stdout: 'ignore', stderr: 'ignore' });
    try {
      const registered = new Date();
      const processInfo: ProcessInfo = { start: async () => registered, command: async () => null };
      const w = await world('RUN', {}, {}, NO_APPROVALS, processInfo);
      await registerPid(w, child.pid, registered);
      await w.ex.reap(w.row, new Date(registered.getTime() - 60_000));
      await waitFor(() => !isProcessAlive(child.pid));
    } finally {
      child.kill();
    }
  });
});

describe('HostExecutor RUN', () => {
  test('wires the production logger into progress commit failures (#186)', async () => {
    const w = await world();
    await w.ex.prepare(w.row);
    const repoDir = join(w.workspaceRoot, 'acme', 'app');
    await writeFile(join(repoDir, '.nax/features/feat/prd.json'), `${PRD}\n`);
    await writeFile(join(repoDir, '.git/index.lock'), 'locked');
    expect(await w.ex.pushProgress({ ...w.row, branch: 'feat/feat' })).toEqual({ kind: 'failed', reason: 'commit failed' });
    expect(w.log.lines).toContainEqual(expect.objectContaining({ level: 'warn', message: 'progress commit failed', fields: expect.objectContaining({ jobId: 'cjob1', exitCode: 128, stderr: expect.stringContaining('index.lock') }) }));
  });
  test('prepare, spawn, watch the files, verdict, ledger, bundle, cleanup', async () => {
    // The fake lookup reports the job's own argv for its pid (the nax child carries its profile), never `ps`.
    const spawned = new Map<number, string>();
    const processInfo: ProcessInfo = { start: async () => null, command: async (pid) => spawned.get(pid) ?? null };
    const w = await world('RUN', {}, {}, NO_APPROVALS, processInfo);
    expect(await w.ex.prepare(w.row)).toEqual({ ok: true, branch: 'feat/feat' });
    const profile = JSON.parse(await readFile(jobProfilePath(w.naxHome, 'cjob1'), 'utf8'));
    expect(profile.outputDir).toBe(join(w.row.jobDir, 'nax-out'));
    expect(profile.name).toMatch(/^acme-app-[0-9a-f]{8}$/);
    const handle = await w.ex.spawn(w.row);
    expect(w.ex.isAlive(handle.pid)).toBe(true);
    spawned.set(handle.pid, `nax run --headless --profile ${jobProfileName('cjob1')}`);
    const running = w.journal.updateJob('cjob1', 1, { pid: handle.pid, pgid: handle.pgid }) as JobRow;
    expect(await w.ex.matchesProcess(running)).toBe(true);
    expect(await w.ex.matchesProcess({ ...running, jobId: 'other' })).toBe(false);
    expect(await w.ex.matchesProcess({ ...running, pid: null })).toBe(false);
    await waitFor(() => !w.ex.isAlive(handle.pid));
    const status = await w.ex.readStatus(w.row);
    expect(runVerdict({ cancelRequested: false, status })).toEqual({ state: 'COMPLETED', reason: null });
    const ledger = await w.ex.readFinishLedger(w.row);
    expect(ledger?.branch).toBe('feat/feat');
    expect(await sh(w.origin.dir, 'rev-parse', 'feat/feat')).toBe(ledger?.headSha as string);
    const bundle = await w.ex.collectBundle(w.row);
    const list = Bun.spawn(['tar', '-tzf', bundle.path], { stdout: 'pipe' });
    const names = (await new Response(list.stdout).text()).split('\n');
    expect(names).toContain('nax-out/status.json');
    expect(names).toContain('nax.stdout');
    expect(names.some((n) => n.includes('prompt-audit'))).toBe(false);
    await w.ex.cleanup(w.row);
    await expect(stat(jobProfilePath(w.naxHome, 'cjob1'))).rejects.toThrow();
  });
  test('the watcher sees snapshots from the real process', async () => {
    const w = await world();
    await w.ex.prepare(w.row);
    const handle = await w.ex.spawn(w.row);
    const snaps: unknown[] = [];
    const watcher = w.ex.createWatcher(w.row, { snapshot: (p) => { snaps.push(p); }, lifecycle: () => undefined }, {});
    while (w.ex.isAlive(handle.pid)) { await watcher.tick(); await Bun.sleep(15); }
    await watcher.tick(true);
    expect(snaps.length).toBeGreaterThan(1);
    expect(await readFile(join(w.row.jobDir, 'nax.stdout'), 'utf8')).toContain('story US-003 done');
    // D146: a RUN job's watcher reads the checkout's prd.json (PRD = OLD-1, nothing else set).
    expect((snaps as SnapshotEventPayload[]).find((s) => s.stories !== undefined)).toMatchObject({
      stories: [{ id: 'OLD-1', title: '', status: 'pending', attempts: 0, dependsOn: [] }], storiesTruncated: false,
    });
  });
  test('logSources names the job\'s three log files; only a RUN job has a run log (S2a §2.4, plan D321)', async () => {
    const run = await world();
    expect(run.ex.logSources(run.row)).toEqual({
      outDir: join(run.row.jobDir, 'nax-out'), feature: run.row.assign.feature,
      stdoutPath: join(run.row.jobDir, 'nax.stdout'), stderrPath: join(run.row.jobDir, 'nax.stderr'), runLog: true,
    });
    const plan = await world('PLAN');
    expect(plan.ex.logSources(plan.row).runLog).toBe(false);
  });
  test('prepare wipes a previous attempt of the same job (D53) and prepares again', async () => {
    const w = await world();
    await mkdir(join(w.row.jobDir, 'nax-out'), { recursive: true });
    await writeFile(join(w.row.jobDir, 'nax-out', 'status.json'), '{"run":{"id":"stale","status":"completed"}}');
    await writeFile(join(w.row.jobDir, 'nax.stdout'), 'stale');
    expect((await w.ex.prepare(w.row)).ok).toBe(true);
    expect(await w.ex.readStatus(w.row)).toBeNull();
    await expect(stat(join(w.row.jobDir, 'nax.stdout'))).rejects.toThrow();
  });
  test.each([
    [{ ref: 'nope' }, 'checkout: ref not found'],
    [{ feature: 'ghost' }, 'checkout: no prd.json at ref'],
  ])('prepare failures map to fixed reasons: %j', async (over, reason) => {
    const w = await world('RUN', over);
    expect(await w.ex.prepare(w.row)).toEqual({ ok: false, reason });
  });
  test('an unreachable clone url is a workspace: reason', async () => {
    const w = await world();
    const bad = { ...w.row, assign: { ...w.assign, repo: { ...w.assign.repo, cloneUrl: `file://${join(w.base, 'missing.git')}` } } };
    const out = await w.ex.prepare(bad);
    expect(out.ok).toBe(false);
    expect((out as { reason: string }).reason).toMatch(/^workspace: /);
  });
  test('a cancel during prepare is honoured at the next step boundary and no job profile is written (D66)', async () => {
    const early = await world();
    expect(await early.ex.prepare(early.row, { isCancelled: () => true })).toEqual({ ok: false, reason: 'cancelled', cancelled: true });
    await expect(stat(early.row.jobDir)).rejects.toThrow();                       // before anything is written
    const later = await world();
    let polls = 0;
    const out = await later.ex.prepare(later.row, { isCancelled: () => (polls += 1) > 2 });   // after clone and clean
    expect(out).toEqual({ ok: false, reason: 'cancelled', cancelled: true });
    await expect(stat(jobProfilePath(later.naxHome, 'cjob1'))).rejects.toThrow();
  });
  test('a job dir outside <workspaceRoot>/.jobs is refused before anything is written', async () => {
    const w = await world();
    const outside = { ...w.row, jobDir: join(w.base, 'elsewhere') };
    const out = await w.ex.prepare(outside);
    expect(out).toEqual({ ok: false, reason: 'workspace: path escapes its root' });
    await expect(stat(join(w.base, 'elsewhere'))).rejects.toThrow();
  });
  test('kill sends the signal to the whole group and reap tolerates an absent registry', async () => {
    const w = await world();
    await w.ex.prepare(w.row);
    process.env['FAKE_NAX_SCENARIO'] = 'hang';
    const handle = await w.ex.spawn(w.row);
    delete process.env['FAKE_NAX_SCENARIO'];
    w.ex.kill(handle.pgid, 'SIGTERM');
    await waitFor(() => !isProcessAlive(handle.pid));
    await w.ex.reap(w.row, new Date(Date.now() - 60_000));
  });
});

describe('HostExecutor PLAN', () => {
  test('reads this attempt\'s fixture ledger without status.json and excludes previous attempts (#203)', async () => {
    const w = await world('PLAN');
    await w.ex.prepare(w.row);
    const costDir = join(w.row.jobDir, 'nax-out', 'cost');
    await mkdir(costDir);
    await copyFile(join(import.meta.dir, '../fixtures/plan-cost.jsonl'), join(costDir, 'plan.jsonl'));
    expect(await w.ex.readStatus(w.row)).toBeNull();
    expect(await w.ex.readPlanCost(w.row)).toBe('0.0045');
    await w.ex.prepare(w.row);
    expect(await w.ex.readPlanCost(w.row)).toBe('0.0000');
  });

  test('an unreadable ledger is warned about and does not fail the verdict (#203)', async () => {
    const w = await world('PLAN');
    await w.ex.prepare(w.row);
    await writeFile(join(w.row.jobDir, 'nax-out', 'cost'), 'not a directory');
    expect(await w.ex.readPlanCost(w.row)).toBeUndefined();
    expect(w.log.lines).toContainEqual(expect.objectContaining({ level: 'warn', message: 'PLAN cost ledger unreadable', fields: { jobId: 'cjob1' } }));
  });

  test('wires the production logger into PLAN commit failures (#186)', async () => {
    const w = await world('PLAN');
    await w.ex.prepare(w.row);
    const repoDir = join(w.workspaceRoot, 'acme', 'app');
    await writeFile(join(repoDir, '.nax/features/feat/prd.json'), PRD);
    await writeFile(join(repoDir, '.git/index.lock'), 'locked');
    expect(await w.ex.finishPlan(w.row)).toEqual({ ok: false, reason: 'plan commit failed' });
    expect(w.log.lines).toContainEqual(expect.objectContaining({ level: 'warn', message: 'plan commit failed', fields: expect.objectContaining({ jobId: 'cjob1', exitCode: 128, stderr: expect.stringContaining('index.lock') }) }));
  });
  test('a stale PRD is moved aside, the new one is checked and pushed on its branch, logs reach the bundle', async () => {
    const w = await world('PLAN');
    expect(await w.ex.prepare(w.row)).toEqual({ ok: true, branch: null });
    expect(await readFile(join(w.row.jobDir, 'pre-plan', 'prd.json'), 'utf8')).toBe(PRD);
    const handle = await w.ex.spawn(w.row);
    await waitFor(() => !w.ex.isAlive(handle.pid));
    expect(await w.ex.readStatus(w.row)).toBeNull();
    const check = await w.ex.readPlan(w.row);
    expect(check).toMatchObject({ ok: true, branchName: 'feat/feat' });
    const pushed = await w.ex.finishPlan(w.row);
    expect(pushed).toMatchObject({ ok: true, branch: 'feat/feat' });
    expect(await sh(w.origin.dir, 'rev-parse', 'feat/feat')).toBe((pushed as { sha: string }).sha);
    const bundle = await w.ex.collectBundle(w.row);
    const list = Bun.spawn(['tar', '-tzf', bundle.path], { stdout: 'pipe' });
    expect((await new Response(list.stdout).text()).split('\n')).toContain('plan-logs/plan-1.jsonl');
  });
  test('prepare deletes a previous attempt\'s plan logs, which git clean keeps because plan/ is ignored (D62)', async () => {
    const w = await world('PLAN', {}, { '.gitignore': '.nax/features/*/plan/\n' });
    await w.ex.prepare(w.row);
    const stale = join(w.workspaceRoot, 'acme', 'app', '.nax', 'features', 'feat', 'plan', 'plan-stale.jsonl');
    await mkdir(join(stale, '..'), { recursive: true });
    await writeFile(stale, '{"stale":true}\n');
    await writeFile(join(stale, '..', 'notes.txt'), 'kept: not a jsonl');
    expect((await w.ex.prepare(w.row)).ok).toBe(true);
    await expect(stat(stale)).rejects.toThrow();
    expect(await readFile(join(stale, '..', 'notes.txt'), 'utf8')).toBe('kept: not a jsonl');
    const handle = await w.ex.spawn(w.row);
    await waitFor(() => !w.ex.isAlive(handle.pid));
    const bundle = await w.ex.collectBundle(w.row);
    const names = (await new Response(Bun.spawn(['tar', '-tzf', bundle.path], { stdout: 'pipe' }).stdout).text()).split('\n');
    expect(names).toContain('plan-logs/plan-1.jsonl');
    expect(names).not.toContain('plan-logs/plan-stale.jsonl');
  });
  test('readPlan and finishPlan use the write-once stash, not a checkout that a crash reverted (D61)', async () => {
    const w = await world('PLAN');
    await w.ex.prepare(w.row);
    const handle = await w.ex.spawn(w.row);
    await waitFor(() => !w.ex.isAlive(handle.pid));
    await w.ex.collectBundle(w.row);                                             // first stash, before any branch switch
    const checkoutPrd = join(w.workspaceRoot, 'acme', 'app', '.nax', 'features', 'feat', 'prd.json');
    await writeFile(checkoutPrd, JSON.stringify({ branchName: 'stale/other', userStories: [{ id: 'OLD' }] }));
    expect(await w.ex.readPlan(w.row)).toMatchObject({ ok: true, branchName: 'feat/feat' });
    const pushed = await w.ex.finishPlan(w.row);
    expect(pushed).toMatchObject({ ok: true, branch: 'feat/feat' });
    expect(JSON.parse(await sh(w.origin.dir, 'show', 'feat/feat:.nax/features/feat/prd.json')).userStories[0].id).toBe('US-001');
  });
  test('D77: a requeue after a failed push re-plans from a wiped job dir and the kept commit still reaches origin', async () => {
    const w = await world('PLAN');
    const repoDir = join(w.workspaceRoot, 'acme', 'app');
    expect((await w.ex.prepare(w.row)).ok).toBe(true);
    const first = await w.ex.spawn(w.row);
    await waitFor(() => !w.ex.isAlive(first.pid));
    await sh(repoDir, 'remote', 'set-url', 'origin', `file://${join(w.base, 'nowhere.git')}`);
    expect(await w.ex.finishPlan(w.row)).toEqual({ ok: false, reason: 'plan push failed' });
    const kept = await sh(repoDir, 'rev-parse', 'feat/feat');
    await expect(stat(join(w.row.jobDir, 'plan-out', 'prd.json'))).resolves.toBeDefined();

    // The server's requeue is a new lease epoch: a new journal row over the same job directory.
    await sh(repoDir, 'remote', 'set-url', 'origin', w.origin.url);
    const requeued = w.journal.insertJob({ assign: w.assign, leaseEpoch: 2, repoKey: 'acme/app', jobDir: w.row.jobDir }).row;
    expect((await w.ex.prepare(requeued)).ok).toBe(true);
    await expect(stat(join(w.row.jobDir, 'plan-out'))).rejects.toThrow();   // the previous stash is gone: this attempt re-plans
    const second = await w.ex.spawn(requeued);
    await waitFor(() => !w.ex.isAlive(second.pid));
    const pushed = await w.ex.finishPlan(requeued);
    expect(pushed).toMatchObject({ ok: true, branch: 'feat/feat' });
    await sh(w.origin.dir, 'merge-base', '--is-ancestor', kept, 'feat/feat');   // throws if the kept commit was lost
  });
  test('an invalid plan is not rescued by the stale PRD that was moved aside', async () => {
    const w = await world('PLAN');
    await w.ex.prepare(w.row);
    process.env['FAKE_NAX_SCENARIO'] = 'plan-invalid';
    const handle = await w.ex.spawn(w.row);
    delete process.env['FAKE_NAX_SCENARIO'];
    await waitFor(() => !w.ex.isAlive(handle.pid));
    expect(await w.ex.readPlan(w.row)).toMatchObject({ ok: false, reason: 'prd.json has no userStories' });
  });
  test('a repo without .nax fails with the fixed reason', async () => {
    const base = await tmp.make('host');
    const origin = await makeOrigin(base, 'origin', { files: { 'README.md': 'x' } });
    const workspaceRoot = join(base, 'ws');
    const assign: AssignPayload = {
      jobId: 'cjob2', command: 'PLAN', repo: { provider: 'github', owner: 'acme', name: 'bare', defaultBranch: 'main', cloneUrl: origin.url },
      ref: 'main', feature: 'feat', planFrom: 'docs/spec.md', profiles: [], maxCostUsd: '1', bashMode: 'raw', approvalTimeoutSec: 600, gitIdentity: { name: 'b', email: 'b@x' },
    };
    const journal = Journal.open(':memory:');
    const row = journal.insertJob({ assign, leaseEpoch: 1, repoKey: 'acme/bare', jobDir: jobDirFor(workspaceRoot, 'cjob2') }).row;
    const ex = new HostExecutor({ config: { workspaceRoot, naxCommand: ['bun', FAKE], naxHome: join(base, 'nh') }, git: createGit(), log: createMemoryLogger(), nowMs: () => Date.now(), credentials: NO_CREDENTIALS, approvals: NO_APPROVALS });
    expect(await ex.prepare(row)).toEqual({ ok: false, reason: 'no .nax dir' });
  });
});

describe('HostExecutor PLAN expectBranch (US-005)', () => {
  const OTHER_PRD = JSON.stringify({ branchName: 'feat/other', userStories: [{ id: 'US-001' }] });
  /** A PLAN whose stashed PRD names `feat/other`, while its assign expects `feat/add-auth`. */
  async function mismatched() {
    const w = await world('PLAN', { expectBranch: 'feat/add-auth' });
    expect((await w.ex.prepare(w.row)).ok).toBe(true);
    await mkdir(join(w.row.jobDir, 'plan-out'), { recursive: true });
    await writeFile(join(w.row.jobDir, 'plan-out', 'prd.json'), OTHER_PRD);
    return w;
  }

  test('US-005 AC-7: readPlan names branch_mismatch when the stashed PRD names another branch', async () => {
    const w = await mismatched();
    expect(await w.ex.readPlan(w.row)).toMatchObject({ ok: false, reason: 'branch_mismatch', branchName: 'feat/other' });
  });

  test('US-005 AC-8: finishPlan with a mismatched PRD makes no git push call', async () => {
    const w = await mismatched();
    const real = createGit();
    const calls: string[][] = [];
    const recording = {
      run: (args: readonly string[], options: Parameters<typeof real.run>[1]) => { calls.push([...args]); return real.run(args, options); },
      ok: (args: readonly string[], options: Parameters<typeof real.ok>[1]) => { calls.push([...args]); return real.ok(args, options); },
    };
    const ex = new HostExecutor({ config: { workspaceRoot: w.workspaceRoot, naxCommand: ['bun', FAKE], naxHome: w.naxHome }, git: recording, log: createMemoryLogger(), nowMs: () => Date.now(), sleep: async () => undefined, credentials: NO_CREDENTIALS, approvals: NO_APPROVALS });
    expect(await ex.finishPlan(w.row)).toEqual({ ok: false, reason: 'plan output missing' });
    expect(calls.filter((args) => args.includes('push'))).toEqual([]);
    expect(calls.filter((args) => args[0] === 'commit')).toEqual([]);
  });
});

describe('HostExecutor credentials wiring (review minors 2, 7)', () => {
  test('D88: forge-token variables from the daemon environment never reach nax', async () => {
    const w = await world();
    await w.ex.prepare(w.row);
    const dump = join(w.base, 'nax-env.json');
    process.env['GH_TOKEN'] = 'operator-ghs';
    process.env['GITLAB_TOKEN'] = 'operator-gls';
    process.env['FAKE_NAX_ENV_DUMP'] = dump;
    try {
      const handle = await w.ex.spawn(w.row);
      await waitFor(() => !w.ex.isAlive(handle.pid));
    } finally {
      for (const key of ['GH_TOKEN', 'GITLAB_TOKEN', 'FAKE_NAX_ENV_DUMP']) delete process.env[key];
    }
    const env = JSON.parse(await readFile(dump, 'utf8')) as Record<string, string>;
    expect(env['GH_TOKEN']).toBeUndefined();
    expect(env['GITLAB_TOKEN']).toBeUndefined();
    expect(env['NAX_GLOBAL_CONFIG_DIR']).toBe(w.naxHome);   // the rest of the environment is intact
  });
  test('finishPlan hands its cancel probe to the credential acquire and reports the cancelled wait', async () => {
    const w = await world('PLAN');
    await w.ex.prepare(w.row);
    const stash = join(w.row.jobDir, 'plan-out', 'prd.json');   // D61: the write-once stash is what readPlan trusts
    await mkdir(join(w.row.jobDir, 'plan-out'), { recursive: true });
    await writeFile(stash, JSON.stringify({ branchName: 'feat/feat', userStories: [{ id: 'US-1' }] }));
    const seen: { cancelled: boolean | null } = { cancelled: null };
    const credentials: CredentialProvider = {
      acquire: async (_job, options) => {
        seen.cancelled = options.isCancelled?.() === true;
        return seen.cancelled ? { ok: false, reason: 'cancelled', cancelled: true } : { ok: true, credentials: { helper: null, binDir: null } };
      },
      release: async () => undefined,
    };
    const ex = new HostExecutor({ config: { workspaceRoot: w.workspaceRoot, naxCommand: ['bun', FAKE], naxHome: w.naxHome }, git: createGit(), log: createMemoryLogger(), nowMs: () => Date.now(), sleep: async () => undefined, credentials, approvals: NO_APPROVALS });
    expect(await ex.finishPlan(w.row, { isCancelled: () => true })).toEqual({ ok: false, reason: 'cancelled', cancelled: true });
    expect(seen.cancelled).toBe(true);
  });
});

describe('HostExecutor PLAN watcher', () => {
  test('a PLAN job never reads the checkout prd.json (D146)', async () => {
    const w = await world('PLAN');
    expect((await w.ex.prepare(w.row)).ok).toBe(true);
    await mkdir(join(w.row.jobDir, 'nax-out'), { recursive: true });
    await writeFile(join(w.row.jobDir, 'nax-out', 'status.json'), JSON.stringify({ version: 1, run: { id: 'plan-run', status: 'running' } }));
    const snaps: SnapshotEventPayload[] = [];
    const watcher = w.ex.createWatcher(w.row, { snapshot: (p) => { snaps.push(p); }, lifecycle: () => undefined }, {});
    await watcher.tick(true);
    expect(snaps).toHaveLength(1);
    expect(snaps[0]).not.toHaveProperty('stories');
  });
});

describe('HostExecutor approval relay (plan D273, D285)', () => {
  const spy = () => ({
    open: mock(async () => ({ url: 'http://127.0.0.1:1/ask', secret: 's' })),
    close: mock(async () => undefined),
    resume: mock(async () => undefined),
  });

  test('prepare opens the relay and writes the overlay for a non-raw RUN', async () => {
    const approvals = spy();
    const w = await world('RUN', { bashMode: 'gated', approvalTimeoutSec: 60 }, {}, approvals);
    expect(await w.ex.prepare(w.row)).toEqual({ ok: true, branch: 'feat/feat' });
    expect(approvals.open).toHaveBeenCalledTimes(1);
    const profile = JSON.parse(await readFile(jobProfilePath(w.naxHome, 'cjob1'), 'utf8'));
    expect(profile.execution).toEqual({ bashApproval: 'gated', approvalTimeout: 60_000 });
  });
  test('a raw RUN never opens the relay', async () => {
    const approvals = spy();
    const w = await world('RUN', {}, {}, approvals);
    await w.ex.prepare(w.row);
    expect(approvals.open).not.toHaveBeenCalled();
  });
  test('cleanup and releaseApprovals close this epoch only', async () => {
    const approvals = spy();
    const w = await world('RUN', { bashMode: 'escalate' }, {}, approvals);
    await w.ex.cleanup(w.row);
    expect(approvals.close).toHaveBeenCalledWith('cjob1', 1);
    await w.ex.releaseApprovals(w.row);
    expect(approvals.close).toHaveBeenCalledTimes(2);
  });
  test('resumeApprovals resumes only non-raw jobs', async () => {
    const approvals = spy();
    const raw = await world('RUN', {}, {}, approvals);
    await raw.ex.resumeApprovals(raw.row);
    expect(approvals.resume).not.toHaveBeenCalled();
    const gated = await world('RUN', { bashMode: 'escalate' }, {}, approvals);
    await gated.ex.resumeApprovals(gated.row);
    expect(approvals.resume).toHaveBeenCalledTimes(1);
  });
});

describe('HostExecutor workflow result and head (US-002)', () => {
  test('AC-1: readWorkflowResult returns the outcome and reasons written after createdAt', async () => {
    const w = await world();
    expect((await w.ex.prepare(w.row)).ok).toBe(true);
    const repoDir = join(w.workspaceRoot, 'acme', 'app');
    const runDir = join(repoDir, '.nax', 'features', 'feat', 'workflow', 'run-1');
    await mkdir(runDir, { recursive: true });
    await writeFile(join(runDir, 'result.json'), JSON.stringify({ schemaVersion: 1, runId: 'r1', verdict: { outcome: 'ready', reasons: ['a', 'b'] } }));
    const found = await (w.ex as unknown as { readWorkflowResult(job: JobRow): Promise<{ outcome: string; reasons: readonly string[] } | null> }).readWorkflowResult(w.row);
    expect(found?.outcome).toBe('ready');
    expect([...(found?.reasons ?? [])]).toEqual(['a', 'b']);
  });
  test('AC-2: readHead of a non-checkout returns null', async () => {
    const w = await world();
    const missing = await (w.ex as unknown as { readHead(job: JobRow): Promise<string | null> }).readHead(w.row);
    expect(missing).toBeNull();
  });
});

describe('HostExecutor workflow stash and bundle (US-003)', () => {
  test('AC-9: collectBundle of a RUN with a fresh workflow result stashes it into the manifest', async () => {
    const w = await world();
    expect((await w.ex.prepare(w.row)).ok).toBe(true);
    const repoDir = join(w.workspaceRoot, 'acme', 'app');
    const runDir = join(repoDir, '.nax', 'features', 'feat', 'workflow', 'run-9');
    await mkdir(runDir, { recursive: true });
    await writeFile(join(runDir, 'result.json'), JSON.stringify({ schemaVersion: 1, runId: 'r9', verdict: { outcome: 'ready', reasons: [] } }));
    await w.ex.collectBundle(w.row);
    const manifest = JSON.parse(await readFile(join(w.row.jobDir, 'bundle-manifest.json'), 'utf8')) as { entries: string[] };
    expect(manifest.entries).toContain('workflow/result.json');
  });
  test('AC-10: preparing a requeued attempt removes the previous workflow folder', async () => {
    const w = await world();
    expect((await w.ex.prepare(w.row)).ok).toBe(true);
    await mkdir(join(w.row.jobDir, 'workflow'), { recursive: true });
    await writeFile(join(w.row.jobDir, 'workflow', 'result.json'), '{}');
    const requeued = w.journal.insertJob({ assign: w.assign, leaseEpoch: 2, repoKey: 'acme/app', jobDir: w.row.jobDir }).row;
    expect((await w.ex.prepare(requeued)).ok).toBe(true);
    await expect(stat(join(w.row.jobDir, 'workflow'))).rejects.toThrow();
    await expect(stat(join(w.row.jobDir, 'workflow', 'result.json'))).rejects.toThrow();
  });
});

describe('HostExecutor REVIEW token file (US-006)', () => {
  const BOT = 'koda-fleet[bot]';
  const TOKEN = 'tok-review-9';
  const HANDLE: SpawnHandle = { pid: 4242, pgid: 4242 };
  type SpawnCall = { readonly argv: readonly string[]; readonly options: SpawnNaxOptions };
  interface Injection {
    currentToken?: string | null;
    omitCurrentToken?: boolean;
    spawnError?: Error | null;
    breakTokenFile?: boolean;
  }

  /**
   * The file's own `world()` fixture (real origin, real temp job dir) with the two US-006 injections: a provider that
   * hands back a fixed token, and a nax start that records its argv and env and starts no process.
   */
  async function injectedWorld(command: 'RUN' | 'REVIEW', over: Injection = {}) {
    const w = await world(command, {
      jobId: 'rjob1',
      ...(command === 'REVIEW' ? { feature: 'review-pr-42', review: { prNumber: 42, botLogin: BOT } } : {}),
    });
    const calls: SpawnCall[] = [];
    const tokenPath = join(w.row.jobDir, REVIEW_TOKEN_FILE);
    const credentials: CredentialProvider = {
      acquire: async () => ({ ok: true, credentials: { helper: null, binDir: null } }),
      release: async () => undefined,
      ...(over.omitCurrentToken === true ? {} : { currentToken: () => (over.currentToken === undefined ? TOKEN : over.currentToken) }),
    };
    const spawnNax = (argv: readonly string[], options: SpawnNaxOptions): SpawnHandle => {
      calls.push({ argv, options });
      // "the token file cannot be removed": something `rm` refuses now sits at its path.
      if (over.breakTokenFile === true) {
        rmSync(tokenPath);
        mkdirSync(join(tokenPath, 'leftover'), { recursive: true });
      }
      if (over.spawnError) throw over.spawnError;
      return HANDLE;
    };
    const ex = new HostExecutor({
      config: { workspaceRoot: w.workspaceRoot, naxCommand: ['bun', FAKE], naxHome: w.naxHome }, git: createGit(), log: w.log,
      nowMs: () => Date.now(), credentials, approvals: NO_APPROVALS, spawnNax,
    });
    await mkdir(w.row.jobDir, { recursive: true });
    return { ...w, calls, ex, tokenPath };
  }

  test('AC-6: spawn calls spawnNax with NAX_FORGE_TOKEN_FILE at <jobDir>/forge-token for a REVIEW job', async () => {
    const w = await injectedWorld('REVIEW');
    const handle = await w.ex.spawn(w.row);
    expect(handle).toEqual({ pid: 4242, pgid: 4242 });
    expect(w.calls).toHaveLength(1);
    expect([...(w.calls[0]?.argv ?? [])]).toEqual(expect.arrayContaining(['bot', 'review', '42']));
    expect(w.calls[0]?.options.env['NAX_FORGE_TOKEN_FILE']).toBe(join(w.row.jobDir, 'forge-token'));
    expect(w.calls[0]?.options.env['NAX_FORGE_TOKEN_FILE']).toBe(w.tokenPath);
    expect(await readFile(w.tokenPath, 'utf8')).toBe(TOKEN);                       // nax reads this, then deletes it
    expect((await stat(w.tokenPath)).mode & 0o777).toBe(0o600);
  });

  test('AC-7: spawn passes the assign\'s bot login as NAX_FORGE_LOGIN', async () => {
    const w = await injectedWorld('REVIEW');
    await w.ex.spawn(w.row);
    expect(w.calls[0]?.options.env['NAX_FORGE_LOGIN']).toBe(BOT);
  });

  test('AC-8: no value in the spawned env is the token itself', async () => {
    const w = await injectedWorld('REVIEW');
    await w.ex.spawn(w.row);
    const values = Object.values(w.calls[0]?.options.env ?? {});
    expect(values).not.toContain(TOKEN);
    expect(JSON.stringify(w.calls[0]?.options.env)).not.toContain(TOKEN);          // nor inside PATH, argv or a blob
  });

  test('AC-9: a RUN job spawns with no NAX_FORGE_TOKEN_FILE key, even when the daemon inherited one', async () => {
    const w = await injectedWorld('RUN');
    process.env['NAX_FORGE_TOKEN_FILE'] = '/elsewhere/forge-token';
    try {
      await w.ex.spawn(w.row);
    } finally {
      delete process.env['NAX_FORGE_TOKEN_FILE'];
    }
    expect(w.calls).toHaveLength(1);
    expect('NAX_FORGE_TOKEN_FILE' in (w.calls[0]?.options.env ?? {})).toBe(false);
    expect('NAX_FORGE_LOGIN' in (w.calls[0]?.options.env ?? {})).toBe(false);
  });

  test('AC-10: no current token fails the spawn with git token: none, starts nothing and writes nothing', async () => {
    const w = await injectedWorld('REVIEW', { currentToken: null });
    await expect(w.ex.spawn(w.row)).rejects.toThrow('git token: none');
    expect(w.calls).toEqual([]);
    await expect(stat(w.tokenPath)).rejects.toThrow();
  });

  test('a provider without a token lookup cannot start a REVIEW job either', async () => {
    const w = await injectedWorld('REVIEW', { omitCurrentToken: true });
    await expect(w.ex.spawn(w.row)).rejects.toThrow('git token: none');
    expect(w.calls).toEqual([]);
    await expect(stat(w.tokenPath)).rejects.toThrow();
  });

  test('AC-11: a start that throws leaves no token file behind', async () => {
    const w = await injectedWorld('REVIEW', { spawnError: new Error('ENOENT nax') });
    await expect(w.ex.spawn(w.row)).rejects.toThrow('ENOENT nax');
    expect(w.calls).toHaveLength(1);                                               // it did try to start
    await expect(stat(w.tokenPath)).rejects.toThrow();
  });

  test('a token file that cannot be removed never replaces the start error', async () => {
    const w = await injectedWorld('REVIEW', { spawnError: new Error('ENOENT nax'), breakTokenFile: true });
    await expect(w.ex.spawn(w.row)).rejects.toThrow('ENOENT nax');                  // the cause, not the failed cleanup
    expect(w.log.lines).toContainEqual(expect.objectContaining({ level: 'warn', message: 'review token file could not be removed' }));
  });

  test('AC-12: cleanup removes a token file that is still there', async () => {
    const w = await injectedWorld('REVIEW');
    const path = await writeReviewToken(w.row.jobDir, TOKEN);
    expect(await readFile(path, 'utf8')).toBe(TOKEN);
    await w.ex.cleanup(w.row);
    await expect(stat(w.tokenPath)).rejects.toThrow();
  });

  test('cleanup warns, and still ends, when the token file cannot be removed', async () => {
    const w = await injectedWorld('REVIEW');
    const path = await writeReviewToken(w.row.jobDir, TOKEN);
    rmSync(path);
    mkdirSync(join(path, 'leftover'), { recursive: true });
    await expect(w.ex.cleanup(w.row)).resolves.toBeUndefined();
    expect(w.log.lines).toContainEqual(expect.objectContaining({ level: 'warn', message: 'review token file could not be removed' }));
  });

  test('AC-13: the attempt wipe removes a token file an earlier attempt left, before the retry runs', async () => {
    const w = await injectedWorld('REVIEW');
    await writeReviewToken(w.row.jobDir, 'tok-from-the-previous-attempt');
    expect(await w.ex.prepare(w.row)).toEqual({ ok: true, branch: null });
    await expect(stat(w.tokenPath)).rejects.toThrow();
    await w.ex.spawn(w.row);
    expect(await readFile(w.tokenPath, 'utf8')).toBe(TOKEN);                       // only this attempt's token is there
  });
});
