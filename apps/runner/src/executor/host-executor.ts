import { copyFile, mkdir, readFile, readdir, rename, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { buildBundle, type BundleFile } from '../bundle/build-bundle';
import type { RunnerConfig } from '../config/runner-config';
import type { JobRow } from '../journal/types';
import type { Logger } from '../logger';
import { assertInside, featureDirFor, repoDirFor } from '../paths/safe-segment';
import { checkPlanPrd, type PlanCheck } from '../verdict/plan-verdict';
import type { StatusView } from '../verdict/status-view';
import { Watcher, type WatcherSink } from '../watcher/watcher';
import { readStatusFile } from '../watcher/status-snapshot';
import { prepareCheckout } from './checkout';
import { reasonFromError, type Git } from './git';
import type { JobExecutor, JobWatcher, PlanPushOutcome, PrepareOptions, PrepareOutcome, SpawnHandle, WatchOptions } from './job-executor';
import { deleteJobProfile, jobProfileName, projectNameFor, writeJobProfile } from './job-profile';
import { buildNaxArgv, isProcessAlive, signalGroup, spawnNax } from './nax-process';
import { readProcessCommand, reapNaxPids } from './pid-registry';
import { commitAndPushPlan, stashPlanOutputs } from './plan-commit';
import { cleanWorkspace, ensureClone } from './workspace';

export interface HostExecutorDeps {
  readonly config: Pick<RunnerConfig, 'workspaceRoot' | 'naxCommand' | 'naxHome'>;
  readonly git: Git;
  readonly log: Logger;
  readonly nowMs: () => number;
}

const ATTEMPT_FILES = ['nax-out', 'nax.stdout', 'nax.stderr', 'pre-plan', 'plan-out', 'plan-out.tmp', 'plan-logs', 'plan-logs.tmp', 'bundle.tar.gz', 'bundle.list', 'bundle-manifest.json'];
const CANCELLED: PrepareOutcome = { ok: false, reason: 'cancelled', cancelled: true };
const exists = (path: string): Promise<boolean> => stat(path).then(() => true, () => false);

async function moveAside(from: string, to: string): Promise<void> {
  try {
    await rename(from, to);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') return;
    if (code !== 'EXDEV') throw error;
    await copyFile(from, to);
    await rm(from, { force: true });
  }
}

/** Design §2, run on the machine that owns the checkout. Every step is idempotent, so a resumed job may repeat it. */
export class HostExecutor implements JobExecutor {
  constructor(private readonly deps: HostExecutorDeps) {}

  private dirs(job: JobRow): { repoDir: string; jobDir: string; outDir: string } {
    const { workspaceRoot } = this.deps.config;
    const jobDir = assertInside(join(workspaceRoot, '.jobs'), job.jobDir);
    return { repoDir: repoDirFor(workspaceRoot, job.assign.repo.owner, job.assign.repo.name), jobDir, outDir: join(jobDir, 'nax-out') };
  }

  async prepare(job: JobRow, options: PrepareOptions = {}): Promise<PrepareOutcome> {
    const cancelled = (): boolean => options.isCancelled?.() === true;   // D66: polled at every step boundary
    try {
      const { repoDir, jobDir, outDir } = this.dirs(job);
      const { assign } = job;
      if (cancelled()) return CANCELLED;
      await Promise.all(ATTEMPT_FILES.map((name) => rm(join(jobDir, name), { recursive: true, force: true })));
      await mkdir(jobDir, { recursive: true });
      await ensureClone(this.deps.git, { repoDir, cloneUrl: assign.repo.cloneUrl, identity: assign.gitIdentity });
      if (cancelled()) return CANCELLED;
      await cleanWorkspace(this.deps.git, repoDir);
      if (cancelled()) return CANCELLED;
      const checkout = await prepareCheckout({ git: this.deps.git, repoDir, assign });
      if (!checkout.ok) return { ok: false, reason: checkout.reason };
      if (assign.command === 'PLAN') await this.moveStalePlanFiles(repoDir, jobDir, assign.feature);
      if (cancelled()) return CANCELLED;
      await mkdir(outDir, { recursive: true });
      await writeJobProfile(this.deps.config.naxHome, job.jobId, outDir, projectNameFor(assign.repo.owner, assign.repo.name));
      return { ok: true, branch: checkout.branch };
    } catch (error) {
      return { ok: false, reason: reasonFromError(error) };
    }
  }

  /**
   * Design §2 step 4: a stale prd.json or prd.rejected.json must not pass the PLAN verdict. D62: `plan/` is gitignored,
   * so `clean -ffd` kept a previous attempt's `plan/*.jsonl`; they would be bundled as this attempt's, so they go too.
   */
  private async moveStalePlanFiles(repoDir: string, jobDir: string, feature: string): Promise<void> {
    const dir = featureDirFor(repoDir, feature);
    await mkdir(join(jobDir, 'pre-plan'), { recursive: true });
    for (const name of ['prd.json', 'prd.rejected.json']) await moveAside(join(dir, name), join(jobDir, 'pre-plan', name));
    const stale = (await readdir(join(dir, 'plan')).catch(() => [] as string[])).filter((name) => name.endsWith('.jsonl'));
    await Promise.all(stale.map((name) => rm(join(dir, 'plan', name), { force: true })));
  }

  async spawn(job: JobRow): Promise<SpawnHandle> {
    const { repoDir, jobDir } = this.dirs(job);
    const argv = buildNaxArgv(this.deps.config.naxCommand, job.assign);
    return spawnNax(argv, {
      cwd: repoDir, stdoutPath: join(jobDir, 'nax.stdout'), stderrPath: join(jobDir, 'nax.stderr'),
      env: { ...process.env, NAX_GLOBAL_CONFIG_DIR: this.deps.config.naxHome },
    });
  }

  isAlive(pid: number): boolean {
    return isProcessAlive(pid);
  }

  async matchesProcess(job: JobRow): Promise<boolean> {
    if (job.pid === null) return false;
    const command = await readProcessCommand(job.pid);
    return command !== null && command.includes(jobProfileName(job.jobId));
  }

  kill(pgid: number, signal: 'SIGTERM' | 'SIGKILL'): void {
    signalGroup(pgid, signal);
  }

  async reap(job: JobRow, since: Date): Promise<void> {
    const killed = await reapNaxPids({ repoDir: this.dirs(job).repoDir, since });
    if (killed.length > 0) this.deps.log.info('reaped registered pids', { jobId: job.jobId, killed });
  }

  createWatcher(job: JobRow, sink: WatcherSink, options: WatchOptions): JobWatcher {
    const { jobDir, outDir } = this.dirs(job);
    return new Watcher(sink, {
      outDir, feature: job.assign.feature, stdoutPath: join(jobDir, 'nax.stdout'), stderrPath: join(jobDir, 'nax.stderr'),
      startAtEnd: options.startAtEnd, nowMs: this.deps.nowMs, onRunIds: options.onRunIds,
    });
  }

  async readStatus(job: JobRow): Promise<StatusView | null> {
    return (await readStatusFile(join(this.dirs(job).outDir, 'status.json'))).status;
  }

  /** D61: once the write-once stash exists it is the PRD; the checkout may have been switched back to the ref's stale one. */
  async readPlan(job: JobRow): Promise<PlanCheck> {
    const { repoDir, jobDir } = this.dirs(job);
    const stashed = join(jobDir, 'plan-out', 'prd.json');
    const path = (await exists(stashed)) ? stashed : join(featureDirFor(repoDir, job.assign.feature), 'prd.json');
    return checkPlanPrd(await readFile(path, 'utf8').catch(() => null));
  }

  async finishPlan(job: JobRow): Promise<PlanPushOutcome> {
    const { repoDir, jobDir } = this.dirs(job);
    const check = await this.readPlan(job);
    if (!check.ok || check.branchName === null) return { ok: false, reason: check.branchName === null && check.ok ? 'checkout: invalid branchName' : 'plan output missing' };
    const refSha = (await this.deps.git.ok(['rev-parse', 'HEAD'], { cwd: repoDir })).trim();
    const result = await commitAndPushPlan({
      git: this.deps.git, repoDir, jobDir, feature: job.assign.feature, jobId: job.jobId,
      branchName: check.branchName, refSha, defaultBranch: job.assign.repo.defaultBranch, identity: job.assign.gitIdentity,
    });
    return result.ok ? { ok: true, branch: result.branch, sha: result.sha } : { ok: false, reason: result.reason };
  }

  async readFinishLedger(job: JobRow): Promise<{ branch: string; headSha: string } | null> {
    const path = join(this.dirs(job).outDir, 'finish-audit', job.assign.feature, 'last.json');
    try {
      const ledger = JSON.parse(await readFile(path, 'utf8')) as Record<string, unknown>;
      return typeof ledger['branch'] === 'string' && typeof ledger['headSha'] === 'string' ? { branch: ledger['branch'], headSha: ledger['headSha'] } : null;
    } catch {
      return null;
    }
  }

  async collectBundle(job: JobRow): Promise<BundleFile> {
    const { repoDir, jobDir } = this.dirs(job);
    if (job.command === 'PLAN') await stashPlanOutputs(repoDir, jobDir, job.assign.feature);
    return buildBundle({ jobDir, command: job.command });
  }

  async cleanup(job: JobRow): Promise<void> {
    await deleteJobProfile(this.deps.config.naxHome, job.jobId);
  }
}
