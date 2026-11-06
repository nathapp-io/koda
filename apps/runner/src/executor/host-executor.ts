import { chmod, copyFile, mkdir, readFile, readdir, realpath, rename, rm, stat } from 'node:fs/promises';
import { delimiter, dirname, join, relative, resolve, sep } from 'node:path';
import { isConfigKind } from '@nathapp/fleet-protocol';
import type { ApprovalRelay } from '../approvals/approval-relay';
import { NO_JOB_CHECK, type JobCheck } from '../capabilities/job-check';
import { buildBundle, type BundleFile } from '../bundle/build-bundle';
import type { RunnerConfig } from '../config/runner-config';
import type { CredentialProvider } from '../credentials/broker';
import { withoutCredentialVars } from '../credentials/credential-env';
import { errorMessage } from '../errors';
import type { JobRow } from '../journal/types';
import type { JobLogSources } from '../logs/types';
import type { Logger } from '../logger';
import { assertInside, featureDirFor, repoDirFor } from '../paths/safe-segment';
import { checkPlanPrd, type PlanCheck } from '../verdict/plan-verdict';
import { readPlanCost } from '../verdict/plan-cost';
import { fixBudgetRemainder } from '../verdict/fix-budget';
import type { StatusView } from '../verdict/status-view';
import { findWorkflowResult, type WorkflowResult } from '../verdict/workflow-result';
import { Watcher, type WatcherSink } from '../watcher/watcher';
import { readStatusFile } from '../watcher/status-snapshot';
import { reviewPosted } from '../verdict/review-posted';
import { readFixResult, readFixState, type FixOutcome } from '../verdict/fix-result';
import { prepareConfigCheckout } from './config-job/checkout';
import { configBranchName } from './config-job/commit-push';
import { runConfigJob } from './config-job/config-job';
import { prepareCheckout } from './checkout';
import { reasonFromError, type Git } from './git';
import type { ConfigJobContext, ConfigJobRun, JobExecutor, JobWatcher, FinishPlanOptions, PlanPushOutcome, PrepareOptions, PrepareOutcome, PushProgressOptions, SpawnHandle, WatchOptions } from './job-executor';
import { deleteJobProfile, jobProfileName, projectNameFor, writeJobProfile } from './job-profile';
import { buildFixArgv, buildNaxArgv, isProcessAlive, signalGroup, spawnNax, type SpawnNaxOptions } from './nax-process';
import { PS_PROCESS_INFO, reapNaxPids, type ProcessInfo } from './pid-registry';
import { commitAndPushPlan, stashPlanOutputs } from './plan-commit';
import { releaseProviderSocket, serveProviderSocket } from './provider-socket';
import { stashWorkflowOutputs } from './workflow-stash';
import { pushProgress, type ProgressPushOutcome } from './progress-push';
import { removeReviewToken, writeReviewToken } from './review-token';
import { REVIEW_DECISIONS_FILE, writeReviewDecisions } from './review-decisions-file';
import { REVIEW_RULINGS_FILE, writeReviewRulings } from './review-rulings-file';
import { cleanWorkspace, ensureClone } from './workspace';

export const FORGE_TOKEN_MIN_REMAINING_MS = 3_000_000;

export interface HostExecutorDeps {
  readonly config: Pick<RunnerConfig, 'workspaceRoot' | 'naxCommand' | 'naxHome'>;
  readonly git: Git;
  readonly log: Logger;
  readonly nowMs: () => number;
  /** D77: the PLAN push back-off; tests inject a no-op. */
  readonly sleep?: (ms: number) => Promise<void>;
  /** Design §3.1: per-job git credentials (the broker; a stub in `file://` specs). */
  readonly credentials: CredentialProvider;
  /** Spec §4.1: the approval relay; a `type` import — a value import would make an executor -> approvals -> supervisor cycle. */
  readonly approvals: Pick<ApprovalRelay, 'open' | 'close' | 'resume'>;
  /** D104: nax mode only. Absent: no post-checkout check (static capabilities, unit specs). */
  readonly jobCheck?: JobCheck;
  /** The process lookups for the identity check and the reap; unset reads `ps` (PS_PROCESS_INFO). Unit specs inject fakes. */
  readonly processInfo?: ProcessInfo;
  /** US-006: the nax start; unset runs the module's `spawnNax`. A spec records argv and env without a process. */
  readonly spawnNax?: (argv: readonly string[], options: SpawnNaxOptions) => SpawnHandle;
}

// D53: a new attempt (including a requeue, which is a new lease epoch over the same job dir, D77) starts from none of these.
// US-008: `forge-token` is a REVIEW/FIX token file; a retry must not start with the previous attempt's.
const ATTEMPT_FILES = ['nax-out', 'nax.stdout', 'nax.stderr', 'fix.stdout', 'fix.stderr', 'pre-plan', 'plan-out', 'plan-out.tmp', 'plan-logs', 'plan-logs.tmp', 'bundle.tar.gz', 'bundle.list', 'bundle-manifest.json', 'workflow', 'forge-token', REVIEW_DECISIONS_FILE, REVIEW_RULINGS_FILE];
const CANCELLED = { ok: false, reason: 'cancelled', cancelled: true } as const satisfies PrepareOutcome;
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

  /** Unset means `ps` (PS_PROCESS_INFO); a spec injects its own lookups and never spawns `ps`. */
  private processInfo(): ProcessInfo {
    return this.deps.processInfo ?? PS_PROCESS_INFO;
  }

  private dirs(job: JobRow): { repoDir: string; jobDir: string; outDir: string } {
    const { workspaceRoot } = this.deps.config;
    const jobDir = assertInside(join(workspaceRoot, '.jobs'), job.jobDir);
    return { repoDir: repoDirFor(workspaceRoot, job.assign.repo.owner, job.assign.repo.name), jobDir, outDir: join(jobDir, 'nax-out') };
  }

  /** Design §2 steps 1-2, shared by nax jobs and config jobs (D480): attempt files wiped, credentials, clone, clean. */
  private async prepareWorkspace(job: JobRow, cancelled: () => boolean): Promise<{ ok: true; repoDir: string; jobDir: string; outDir: string } | { ok: false; reason: string; cancelled?: true }> {
    const { repoDir, jobDir, outDir } = this.dirs(job);
    if (cancelled()) return CANCELLED;
    await Promise.all(ATTEMPT_FILES.map((name) => rm(join(jobDir, name), { recursive: true, force: true })));
    await mkdir(jobDir, { recursive: true, mode: 0o700 });
    await chmod(jobDir, 0o700);   // D93: it holds the shims
    const acquired = await this.deps.credentials.acquire(job, { wait: true, isCancelled: cancelled });
    if (!acquired.ok) return acquired.cancelled ? CANCELLED : { ok: false, reason: acquired.reason };
    const { helper } = acquired.credentials;
    await ensureClone(this.deps.git, { repoDir, cloneUrl: job.assign.repo.cloneUrl, identity: job.assign.gitIdentity, credentialHelper: helper });
    if (cancelled()) return CANCELLED;
    await cleanWorkspace(this.deps.git, repoDir, helper);
    if (cancelled()) return CANCELLED;
    return { ok: true, repoDir, jobDir, outDir };
  }

  async prepare(job: JobRow, options: PrepareOptions = {}): Promise<PrepareOutcome> {
    const cancelled = (): boolean => options.isCancelled?.() === true;   // D66: polled at every step boundary
    try {
      const workspace = await this.prepareWorkspace(job, cancelled);
      if (!workspace.ok) return workspace;
      const { repoDir, jobDir, outDir } = workspace;
      const { assign } = job;
      const checkout = await prepareCheckout({ git: this.deps.git, repoDir, assign });
      if (!checkout.ok) return { ok: false, reason: checkout.reason };
      const mismatch = await (this.deps.jobCheck ?? NO_JOB_CHECK).check(job, repoDir);   // D104
      if (mismatch !== null) return { ok: false, reason: mismatch };
      if (assign.command === 'PLAN') await this.moveStalePlanFiles(repoDir, jobDir, assign.feature);
      if (cancelled()) return CANCELLED;
      await mkdir(outDir, { recursive: true });
      const relay = assign.bashMode === 'raw' ? undefined
        : { bashMode: assign.bashMode, approvalTimeoutSec: assign.approvalTimeoutSec, endpoint: await this.deps.approvals.open(job) };
      const botCostLimitUsd = assign.command === 'REVIEW' || assign.command === 'FIX' ? Number(assign.maxCostUsd) : undefined;
      await writeJobProfile(this.deps.config.naxHome, job.jobId, outDir, projectNameFor(assign.repo.owner, assign.repo.name), relay, botCostLimitUsd);
      return { ok: true, branch: checkout.branch };
    } catch (error) {
      return { ok: false, reason: reasonFromError(error) };
    }
  }

  async prepareConfigJob(job: JobRow, options: PrepareOptions = {}): Promise<PrepareOutcome> {
    const cancelled = (): boolean => options.isCancelled?.() === true;
    try {
      const workspace = await this.prepareWorkspace(job, cancelled);
      if (!workspace.ok) return workspace;
      const checkout = await prepareConfigCheckout(this.deps.git, workspace.repoDir, job.assign.repo.defaultBranch);
      return checkout.ok ? { ok: true, branch: null } : { ok: false, reason: checkout.reason };
    } catch (error) {
      return { ok: false, reason: reasonFromError(error) };
    }
  }

  runConfigJob(job: JobRow, ctx: ConfigJobContext): Promise<ConfigJobRun> {
    const { repoDir, jobDir } = this.dirs(job);
    const { git, credentials, nowMs, sleep, log } = this.deps;
    return runConfigJob({ git, naxCommand: this.deps.config.naxCommand, naxHome: this.deps.config.naxHome, credentials, nowMs, log, ...(sleep ? { sleep } : {}) }, job, { repoDir, jobDir }, ctx);
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
    const reviewJob = job.command === 'REVIEW' || job.command === 'FIX';
    const decisions = reviewJob ? job.assign.review?.decisions : undefined;
    const decisionsPath = decisions !== undefined && decisions.length > 0 ? await writeReviewDecisions(jobDir, decisions) : undefined;
    const rulings = job.command === 'FIX' ? job.assign.review?.rulings : undefined;
    const rulingsPath = rulings !== undefined && rulings.rulings.length > 0 ? await writeReviewRulings(jobDir, rulings) : undefined;
    const argv = buildNaxArgv(this.deps.config.naxCommand, job.assign, {
      ...(decisionsPath === undefined ? {} : { decisionsPath }),
      ...(rulingsPath === undefined ? {} : { rulingsPath }),
    });
    const acquired = await this.deps.credentials.acquire(job, { wait: false });
    const binDir = acquired.ok ? acquired.credentials.binDir : null;
    const inherited = process.env['PATH'] ?? '';
    // D88: the shims come first on nax's PATH; no token variable is ever set here.
    const path = binDir ? `${binDir}${delimiter}${inherited}` : inherited;
    const env: Record<string, string | undefined> = { ...withoutCredentialVars(process.env), NAX_GLOBAL_CONFIG_DIR: this.deps.config.naxHome, PATH: path };
    // US-009: the provider-key socket this job epoch serves, never a key: nax's exec helper reads the key over it.
    Object.assign(env, await serveProviderSocket(this.deps.credentials, job, this.deps.log));
    // US-006: a REVIEW overlays the stripped environment AFTER stripping, so a copy the daemon inherited cannot leak in.
    // #395: a GitHub RUN gets the same overlay, best-effort (see runIdentityEnv).
    const identity = reviewJob ? await this.reviewEnv(job, jobDir) : await this.runIdentityEnv(job, jobDir);
    Object.assign(env, identity);
    const tokenWritten = identity['NAX_FORGE_TOKEN_FILE'] !== undefined;
    const options: SpawnNaxOptions = {
      cwd: repoDir, stdoutPath: join(jobDir, 'nax.stdout'), stderrPath: join(jobDir, 'nax.stderr'), env,
    };
    try {
      return this.startNax(argv, options);
    } catch (error) {
      if (tokenWritten) await this.dropReviewToken(job, jobDir);   // no nax started, so nothing else deletes the token file
      throw error;
    }
  }

  async spawnFixStep(job: JobRow): Promise<SpawnHandle> {
    const { repoDir, jobDir, outDir } = this.dirs(job);
    const assign = job.assign;
    const spentUsd = await this.readPlanCost(job);
    const remainder = fixBudgetRemainder(assign.maxCostUsd, spentUsd);
    if (remainder === null) throw new Error('budget spent');

    const acquired = await this.deps.credentials.acquire(job, { wait: false });
    if (!acquired.ok) throw new Error(acquired.reason);
    const binDir = acquired.credentials.binDir;
    const token = await this.forgeToken(job);
    const login = assign.review?.botLogin;
    if (login === undefined) throw new Error('invalid review');

    const argv = buildFixArgv(this.deps.config.naxCommand, assign);
    await writeJobProfile(this.deps.config.naxHome, job.jobId, outDir, projectNameFor(assign.repo.owner, assign.repo.name), undefined, remainder);
    const tokenPath = await writeReviewToken(jobDir, token);
    const inherited = process.env['PATH'] ?? '';
    const env: Record<string, string | undefined> = {
      ...withoutCredentialVars(process.env), NAX_GLOBAL_CONFIG_DIR: this.deps.config.naxHome,
      PATH: binDir ? `${binDir}${delimiter}${inherited}` : inherited,
      NAX_FORGE_TOKEN_FILE: tokenPath, NAX_FORGE_LOGIN: login,
      ...(await serveProviderSocket(this.deps.credentials, job, this.deps.log)),   // US-009: the same socket as the review step
    };
    try {
      return this.startNax(argv, { cwd: repoDir, stdoutPath: join(jobDir, 'fix.stdout'), stderrPath: join(jobDir, 'fix.stderr'), env });
    } catch (error) {
      await this.dropReviewToken(job, jobDir);
      throw error;
    }
  }

  private startNax(argv: readonly string[], options: SpawnNaxOptions): SpawnHandle {
    return (this.deps.spawnNax ?? spawnNax)(argv, options);
  }

  /**
   * US-006: `forge-token` must not outlive a start that failed or a job that ended, but its removal must never hide the
   * error that mattered (the spawn failure) or fail a cleanup whose other steps already ran: it warns instead.
   */
  private async dropReviewToken(job: JobRow, jobDir: string): Promise<void> {
    try {
      await removeReviewToken(jobDir);
    } catch (error) {
      this.deps.log.warn('review token file could not be removed', { jobId: job.jobId, error: errorMessage(error) });
    }
  }

  /**
   * US-006: the narrow file exception to D88. nax K0 rejects a login without a token file, and a GitHub App token
   * cannot answer "who am I": the job's fresh token goes into `<jobDir>/forge-token` (0600), which nax reads and
   * deletes at startup. It is never an environment value or an argv element.
   */
  private async forgeToken(job: JobRow): Promise<string> {
    const getFreshToken = this.deps.credentials.freshToken;
    if (!getFreshToken) throw new Error('git token: none');
    const result = await getFreshToken.call(this.deps.credentials, job, FORGE_TOKEN_MIN_REMAINING_MS);
    if (!result.ok) throw new Error(result.reason);
    return result.token;
  }

  private async reviewEnv(job: JobRow, jobDir: string): Promise<Record<string, string>> {
    const token = await this.forgeToken(job);   // before any file write and before any start
    const login = job.assign.review?.botLogin;
    if (login === undefined) throw new Error('invalid review');   // buildNaxArgv already refused such an assign
    return { NAX_FORGE_TOKEN_FILE: await writeReviewToken(jobDir, token), NAX_FORGE_LOGIN: login };
  }

  /**
   * #395: nax posts a published draft's item threads and item index only after reading "who am I", which a GitHub App
   * installation token cannot answer. A GitHub RUN therefore gets the REVIEW/FIX identity (token file + the App bot
   * login, `gitIdentity.name`). Best-effort: a RUN worked before without it, so a refused token only loses the index.
   * Interim: nax then uses this one token for every forge call, so a RUN longer than the token's remaining life
   * (FORGE_TOKEN_MIN_REMAINING_MS at start) cannot publish; a login-only nax identity removes that limit.
   */
  private async runIdentityEnv(job: JobRow, jobDir: string): Promise<Record<string, string>> {
    if (job.command !== 'RUN' || job.assign.repo.provider !== 'github') return {};
    const getFreshToken = this.deps.credentials.freshToken;
    const result = getFreshToken
      ? await getFreshToken.call(this.deps.credentials, job, FORGE_TOKEN_MIN_REMAINING_MS)
      : { ok: false as const, reason: 'git token: none' };
    // The runner stopping (or the job cancelled) during the token wait is not a missing identity: start nothing.
    if (!result.ok && result.reason === 'cancelled') throw new Error(result.reason);
    if (!result.ok) {
      this.deps.log.warn('RUN starts without a forge identity', { jobId: job.jobId, reason: result.reason });
      return {};
    }
    try {
      return { NAX_FORGE_TOKEN_FILE: await writeReviewToken(jobDir, result.token), NAX_FORGE_LOGIN: job.assign.gitIdentity.name };
    } catch (error) {
      this.deps.log.warn('RUN starts without a forge identity', { jobId: job.jobId, reason: `token file: ${errorMessage(error)}` });
      return {};
    }
  }

  isAlive(pid: number): boolean {
    return isProcessAlive(pid);
  }

  async processIdentity(job: JobRow): Promise<'ours' | 'other' | 'unknown'> {
    if (job.pid === null) return 'unknown';
    let command: string | null;
    try {
      command = await this.processInfo().command(job.pid);
    } catch {
      return 'unknown';
    }
    if (command === null) return 'unknown';
    // Keep the identity rule in one place so READOPT and watch-time checks cannot drift.
    const matches = isConfigKind(job.command)
      ? command.includes(this.dirs(job).repoDir) || command.includes(configBranchName(job.jobId))
      : command.includes(jobProfileName(job.jobId));
    return matches ? 'ours' : 'other';
  }

  async matchesProcess(job: JobRow): Promise<boolean> {
    return (await this.processIdentity(job)) === 'ours';
  }

  kill(pgid: number, signal: 'SIGTERM' | 'SIGKILL'): boolean {
    return signalGroup(pgid, signal);
  }

  async reap(job: JobRow, since: Date): Promise<void> {
    const info = this.processInfo();
    const killed = await reapNaxPids({ repoDir: this.dirs(job).repoDir, since, startedAt: (pid) => info.start(pid) });
    if (killed.length > 0) this.deps.log.info('reaped registered pids', { jobId: job.jobId, killed });
  }

  createWatcher(job: JobRow, sink: WatcherSink, options: WatchOptions): JobWatcher {
    const { outDir, repoDir } = this.dirs(job);
    return new Watcher(sink, {
      outDir, feature: job.assign.feature, onRunIds: options.onRunIds,
      ...(job.command === 'RUN' ? { repoDir } : {}),   // D146: a PLAN checkout's prd.json is an older plan's
    });
  }

  logSources(job: JobRow): JobLogSources {
    const { jobDir, outDir } = this.dirs(job);
    return {
      outDir, feature: job.assign.feature, stdoutPath: join(jobDir, 'nax.stdout'), stderrPath: join(jobDir, 'nax.stderr'),
      runLog: job.command === 'RUN',   // spec §2.4: PLAN jobs never stream a run log
    };
  }

  async readStatus(job: JobRow): Promise<StatusView | null> {
    return (await readStatusFile(join(this.dirs(job).outDir, 'status.json'))).status;
  }

  async readReviewPosted(job: JobRow): Promise<boolean> {
    return reviewPosted(join(this.dirs(job).jobDir, 'nax.stdout'));
  }

  async readFixOutcome(job: JobRow): Promise<FixOutcome> {
    const { jobDir, outDir } = this.dirs(job);
    const prNumber = job.assign.review?.prNumber;
    const result = prNumber === undefined
      ? { kind: 'none' as const, logPath: null }
      : await readFixResult(join(jobDir, 'fix.stdout'), prNumber);

    let fixState: Awaited<ReturnType<typeof readFixState>> = null;
    if (result.logPath !== null && prNumber !== undefined) {
      const expectedRoot = resolve(outDir, 'bot', `pr-${prNumber}`);
      try {
        const realOutDir = await realpath(outDir);
        const realRoot = await realpath(expectedRoot);
        const expectedRealRoot = resolve(realOutDir, 'bot', `pr-${prNumber}`);
        const realLogDir = await realpath(dirname(resolve(result.logPath)));
        const statePath = join(realLogDir, 'bot-state.json');
        const realStatePath = await realpath(statePath);
        const rootRel = relative(expectedRealRoot, realRoot);
        const logRel = relative(realRoot, realLogDir);
        const stateRel = relative(realRoot, realStatePath);
        const inside = (rel: string): boolean => rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`));
        if (rootRel === '' && inside(logRel) && inside(stateRel)) {
          fixState = await readFixState(join(realLogDir, 'bot.jsonl'));
        }
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code !== 'ENOENT' && code !== 'ELOOP') throw error;
      }
    }

    let stderrLine: string | null = null;
    try {
      const stderr = await readFile(join(jobDir, 'fix.stderr'), 'utf8');
      stderrLine = stderr.split(/\r?\n/).map((line) => line.trim()).find((line) => line !== '')?.slice(0, 200) ?? null;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    return { ...result, pushedSha: fixState?.pushedSha ?? null, fixReady: fixState?.fixReady ?? null, stderrLine };
  }

  async hasFixStep(job: JobRow): Promise<boolean> {
    return exists(join(this.dirs(job).jobDir, 'fix.stdout'));
  }

  /** D61: once the write-once stash exists it is the PRD; the checkout may have been switched back to the ref's stale one. */
  async readPlan(job: JobRow): Promise<PlanCheck> {
    const { repoDir, jobDir } = this.dirs(job);
    const stashed = join(jobDir, 'plan-out', 'prd.json');
    const path = (await exists(stashed)) ? stashed : join(featureDirFor(repoDir, job.assign.feature), 'prd.json');
    return checkPlanPrd(await readFile(path, 'utf8').catch(() => null), job.assign.expectBranch);
  }

  async readPlanCost(job: JobRow): Promise<string | undefined> {
    try {
      return await readPlanCost(this.dirs(job).outDir);
    } catch {
      this.deps.log.warn('PLAN cost ledger unreadable', { jobId: job.jobId });
      return undefined;
    }
  }

  async finishPlan(job: JobRow, options: FinishPlanOptions = {}): Promise<PlanPushOutcome> {
    const { repoDir, jobDir } = this.dirs(job);
    const check = await this.readPlan(job);
    if (!check.ok || check.branchName === null) return { ok: false, reason: check.branchName === null && check.ok ? 'checkout: invalid branchName' : 'plan output missing' };
    const acquired = await this.deps.credentials.acquire(job, { wait: true, isCancelled: () => options.isCancelled?.() === true });
    if (!acquired.ok) return acquired.cancelled ? { ok: false, reason: 'cancelled', cancelled: true } : { ok: false, reason: acquired.reason };
    const refSha = (await this.deps.git.ok(['rev-parse', 'HEAD'], { cwd: repoDir })).trim();
    const result = await commitAndPushPlan({
      git: this.deps.git, repoDir, jobDir, feature: job.assign.feature, jobId: job.jobId,
      branchName: check.branchName, refSha, defaultBranch: job.assign.repo.defaultBranch, identity: job.assign.gitIdentity,
      credentialHelper: acquired.credentials.helper,
      log: this.deps.log,
      ...(this.deps.sleep ? { sleep: this.deps.sleep } : {}),
    });
    return result.ok ? { ok: true, branch: result.branch, sha: result.sha } : { ok: false, reason: result.reason };
  }

  async pushProgress(job: JobRow, options: PushProgressOptions = {}): Promise<ProgressPushOutcome> {
    const { repoDir } = this.dirs(job);
    if (job.branch === null) return { kind: 'failed', reason: 'no branch' };
    const halted = (): boolean => options.isHalted?.() === true;
    const acquired = await this.deps.credentials.acquire(job, { wait: true, isCancelled: halted });
    if (!acquired.ok) return acquired.cancelled ? { kind: 'halted' } : { kind: 'failed', reason: acquired.reason };
    return pushProgress({
      git: this.deps.git, repoDir, feature: job.assign.feature, jobId: job.jobId, branchName: job.branch,
      identity: job.assign.gitIdentity, credentialHelper: acquired.credentials.helper, isHalted: halted,
      log: this.deps.log,
      ...(this.deps.sleep ? { sleep: this.deps.sleep } : {}),
    });
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

  async readWorkflowResult(job: JobRow): Promise<WorkflowResult | null> {
    try {
      const { repoDir } = this.dirs(job);
      const found = await findWorkflowResult(featureDirFor(repoDir, job.assign.feature), Date.parse(job.createdAt));
      return found?.result ?? null;
    } catch {
      return null;
    }
  }

  async readHead(job: JobRow): Promise<string | null> {
    try {
      const { repoDir } = this.dirs(job);
      const sha = (await this.deps.git.ok(['rev-parse', 'HEAD'], { cwd: repoDir })).trim();
      return sha === '' ? null : sha;
    } catch {
      return null;
    }
  }

  async collectBundle(job: JobRow): Promise<BundleFile> {
    const { repoDir, jobDir } = this.dirs(job);
    if (job.command === 'PLAN') await stashPlanOutputs(repoDir, jobDir, job.assign.feature);
    if (job.command === 'RUN') await stashWorkflowOutputs(repoDir, jobDir, job.assign.feature, Date.parse(job.createdAt));
    return buildBundle({ jobDir, command: job.command });
  }

  async cleanup(job: JobRow): Promise<void> {
    try {
      await deleteJobProfile(this.deps.config.naxHome, job.jobId);
    } finally {
      try {
        await this.deps.approvals.close(job.jobId, job.leaseEpoch);
      } finally {
        try {
          await this.releaseJobCredentials(job);
        } finally {
          await this.dropReviewToken(job, this.dirs(job).jobDir);   // US-006: a token file nax never got to delete itself
        }
      }
    }
  }

  /**
   * US-009: the git release and the provider-key release are independent — a git failure must not leave the provider
   * socket serving, and the git failure is still the error that surfaces (the provider release only warns).
   */
  private async releaseJobCredentials(job: JobRow): Promise<void> {
    try {
      await this.deps.credentials.release(job);
    } finally {
      await releaseProviderSocket(this.deps.credentials, job, this.deps.log);
    }
  }

  /** D90: a readopted job keeps its deterministic provider-key socket path, so the running nax helper finds it again. */
  async resumeCredentials(job: JobRow): Promise<void> {
    await this.deps.credentials.acquire(job, { wait: false });
    await serveProviderSocket(this.deps.credentials, job, this.deps.log);
  }

  async releaseCredentials(job: JobRow): Promise<void> {
    await this.releaseJobCredentials(job);
  }

  async resumeApprovals(job: JobRow): Promise<void> {
    if (job.assign.bashMode !== 'raw') await this.deps.approvals.resume(job);
  }

  async releaseApprovals(job: JobRow): Promise<void> {
    await this.deps.approvals.close(job.jobId, job.leaseEpoch);
  }
}
