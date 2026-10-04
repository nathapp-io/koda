import type { BundleFile } from '../../src/bundle/build-bundle';
import type { JobExecutor, JobWatcher, FinishPlanOptions, PlanPushOutcome, PrepareOptions, PrepareOutcome, PushProgressOptions, SpawnHandle, WatchOptions } from '../../src/executor/job-executor';
import type { ProgressPushOutcome } from '../../src/executor/progress-push';
import type { JobRow } from '../../src/journal/types';
import type { JobLogSources } from '../../src/logs/types';
import type { PlanCheck } from '../../src/verdict/plan-verdict';
import type { StatusView } from '../../src/verdict/status-view';
import type { WatcherSink } from '../../src/watcher/watcher';

/** A scriptable JobExecutor: every call is recorded as `<name>:<jobId>`; nothing touches disk, git or a process. */
export class FakeExecutor implements JobExecutor {
  readonly calls: string[] = [];
  readonly killed: Array<{ pgid: number; signal: string }> = [];
  readonly watchOptions: WatchOptions[] = [];
  readonly prepareOptions: PrepareOptions[] = [];
  readonly finishPlanOptions: FinishPlanOptions[] = [];
  readonly pushProgressOptions: PushProgressOptions[] = [];
  progressPush: ProgressPushOutcome = { kind: 'pushed', branch: 'feat/x', sha: 'e'.repeat(40) };
  prepareResult: PrepareOutcome = { ok: true, branch: 'feat/x' };
  spawnError: Error | null = null;
  handle: SpawnHandle = { pid: 4242, pgid: 4242 };
  alive = false;
  aliveAfterSpawn = true;
  procMatches = true;
  status: StatusView | null = { run: { id: 'run-1', status: 'completed' }, postRun: { finish: { status: 'passed', result: 'opened', url: 'https://example.test/pr/1' } } };
  statusError: Error | null = null;
  plan: PlanCheck = { ok: true, reason: null, branchName: 'feat/x' };
  planPush: PlanPushOutcome = { ok: true, branch: 'feat/x', sha: 'a'.repeat(40) };
  ledger: { branch: string; headSha: string } | null = { branch: 'feat/x', headSha: 'b'.repeat(40) };
  bundle: BundleFile = { path: '/b.tgz', size: 1, sha256: 'c'.repeat(64) };
  bundleError: Error | null = null;
  resumeError: Error | null = null;
  resumeApprovalsError: Error | null = null;
  /** S2a: paths the job's logs live at; the default points nowhere, so the shipper finds no file. */
  logFiles: JobLogSources = {
    outDir: '/nonexistent/koda-fake/nax-out', feature: 'f',
    stdoutPath: '/nonexistent/koda-fake/nax.stdout', stderrPath: '/nonexistent/koda-fake/nax.stderr', runLog: false,
  };
  ticks = 0;
  onTick: (n: number, final: boolean, sink: WatcherSink) => void = () => undefined;
  onKill: (signal: 'SIGTERM' | 'SIGKILL') => void = () => { this.alive = false; };

  private note(name: string, job: JobRow): void {
    this.calls.push(`${name}:${job.jobId}`);
  }

  /** The process ends on the n-th watcher tick. */
  dieAfterTicks(n: number): void {
    this.onTick = (tick) => { if (tick >= n) this.alive = false; };
  }

  async prepare(job: JobRow, options: PrepareOptions = {}): Promise<PrepareOutcome> {
    this.note('prepare', job);
    this.prepareOptions.push(options);
    return this.prepareResult;
  }

  async spawn(job: JobRow): Promise<SpawnHandle> {
    this.note('spawn', job);
    if (this.spawnError) throw this.spawnError;
    this.alive = this.aliveAfterSpawn;
    return this.handle;
  }

  isAlive(): boolean {
    return this.alive;
  }

  async matchesProcess(): Promise<boolean> {
    return this.alive && this.procMatches;
  }

  kill(pgid: number, signal: 'SIGTERM' | 'SIGKILL'): boolean {
    this.killed.push({ pgid, signal });
    this.onKill(signal);
    return true;
  }

  async reap(job: JobRow): Promise<void> {
    this.note('reap', job);
  }

  createWatcher(_job: JobRow, sink: WatcherSink, options: WatchOptions): JobWatcher {
    this.watchOptions.push(options);
    return { tick: async (final = false) => { this.ticks += 1; this.onTick(this.ticks, final, sink); } };
  }

  logSources(): JobLogSources {
    return this.logFiles;
  }

  async readStatus(job: JobRow): Promise<StatusView | null> {
    this.note('readStatus', job);
    if (this.statusError) throw this.statusError;
    return this.status;
  }

  async readPlan(job: JobRow): Promise<PlanCheck> {
    this.note('readPlan', job);
    return this.plan;
  }

  async finishPlan(job: JobRow, options: FinishPlanOptions = {}): Promise<PlanPushOutcome> {
    this.note('finishPlan', job);
    this.finishPlanOptions.push(options);
    return this.planPush;
  }

  async pushProgress(job: JobRow, options: PushProgressOptions = {}): Promise<ProgressPushOutcome> {
    this.note('pushProgress', job);
    this.pushProgressOptions.push(options);
    return this.progressPush;
  }

  async readFinishLedger(): Promise<{ branch: string; headSha: string } | null> {
    return this.ledger;
  }

  async collectBundle(job: JobRow): Promise<BundleFile> {
    this.note('collectBundle', job);
    if (this.bundleError) throw this.bundleError;
    return this.bundle;
  }

  async cleanup(job: JobRow): Promise<void> {
    this.note('cleanup', job);
  }

  async resumeCredentials(job: JobRow): Promise<void> {
    this.note('resumeCredentials', job);
    if (this.resumeError) throw this.resumeError;
  }

  async releaseCredentials(job: JobRow): Promise<void> {
    this.note('releaseCredentials', job);
  }

  async resumeApprovals(job: JobRow): Promise<void> {
    this.calls.push(`resumeApprovals:${job.jobId}`);
    if (this.resumeApprovalsError) throw this.resumeApprovalsError;
  }

  async releaseApprovals(job: JobRow): Promise<void> {
    this.calls.push(`releaseApprovals:${job.jobId}`);
  }
}
