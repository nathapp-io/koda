import { chmod, mkdir, readdir, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { Database } from 'bun:sqlite';
import type { CommandAck } from '@nathapp/fleet-protocol';
import { configureCredentials as defaultConfigureCredentials, type CredentialsConfig } from '@nathapp/nax-agent';
import { uploadWithRetry } from '../bundle/upload-bundle';
import { ApprovalRelay } from '../approvals/approval-relay';
import type { AcpAgentProbe } from '../capabilities/acp-agent-probe';
import { CapabilityReporter } from '../capabilities/capability-probe';
import { createCapabilityProbe } from '../capabilities/create-probe';
import { NaxJobCheck, StaticJobCheck, type JobCheck } from '../capabilities/job-check';
import { RetryingJobCheck } from '../capabilities/job-check-retry';
import { vaultHelperEnabled } from '../commands/vault';
import type { RunnerConfig, RunnerHome } from '../config/runner-config';
import { errorMessage, StartupError } from '../errors';
import { CredentialBroker } from '../credentials/broker';
import { ProviderKeyCache } from '../credentials/provider-key-cache';
import { TokenCache } from '../credentials/token-cache';
import { defaultSocketDir, ensureSocketDir } from '../credentials/socket-dir';
import { HostExecutor } from '../executor/host-executor';
import { assertMinGitVersion, createGit, type Git } from '../executor/git';
import type { JobExecutor } from '../executor/job-executor';
import { sweepOrphanProfiles } from '../executor/job-profile';
import { newBootId, type RunnerIdentityFile } from '../identity/identity-store';
import { Journal } from '../journal/journal';
import { createConsoleLogger, type Logger } from '../logger';
import { LogShipper } from '../logs/log-shipper';
import { createNaxCli, type NaxCli } from '../nax/nax-cli';
import { assertWorkspaceTrusted } from '../nax/trust';
import { assertInside } from '../paths/safe-segment';
import { selfCommand } from '../self-command';
import { rotateLogFile } from '../service/log-rotate';
import { CommandHandler } from '../supervisor/command-handler';
import { RepoMutex } from '../supervisor/repo-mutex';
import { Supervisor } from '../supervisor/supervisor';
import type { BundleUploader } from '../supervisor/job-run';
import { ServerClient, type FetchFn } from '../sync/http';
import { SyncLoop, type StopReason } from '../sync/sync-loop';
import { naxCredentialsConfig } from '../thread/nax-credentials';
import { ThreadSessionFactory } from '../thread/session-factory';
import { ThreadWorktreeOwners } from '../thread/thread-worktree-owners';
import { threadNativeModels } from '../thread/thread-host';
import type { ThreadRunSetup } from '../thread/thread-job-run';
import { pruneThreads } from '../thread/thread-prune';
import { pruneProjectCode } from '../thread/project-code/mirror-prune';
import { systemNow, systemSleep, type Now, type Sleep } from '../time';
import { installProcessRecording, OwnedProcessLedger, readHostBootId, reapPreviousBootProcesses } from './owned-processes';
import { CapacityTracker, freeSlots } from './capacity';
import { DAEMON_VERSION } from '../version';
import { TUNING, type Tuning } from './tuning';

export interface DaemonOptions {
  readonly home: RunnerHome;
  readonly config: RunnerConfig;
  readonly identity: RunnerIdentityFile;
  readonly fetchFn?: FetchFn;
  readonly tuning?: Partial<Tuning>;
  readonly log?: Logger;
  readonly now?: Now;
  readonly sleep?: Sleep;
  readonly bootId?: string;
  /**
   * US-001: the factory receives the credential broker, so a test's fake executor can wait for a credential the way
   * the real one does.
   */
  readonly executorFactory?: (broker: CredentialBroker) => JobExecutor;
  readonly git?: Git;
  /** D84: how git and the shims run this runner; tests pass ['bun', <src/main.ts>]. */
  readonly selfCommand?: readonly string[];
  /** D96: tests inject a scripted nax; otherwise `createNaxCli(config.naxCommand, config.naxHome)`. */
  readonly nax?: NaxCli;
  /**
   * thread-agents-modes US-002: the ACP agent probe the capability report advertises. The `run` command supplies
   * `probeAcpAgents`; every other caller gets none, and its report says `acp: []` with no `acpOffers`.
   */
  readonly acpProbe?: AcpAgentProbe;
  /** Fleet S5a §3: the thread session factory's `open`; tests inject a fake. Default: `ThreadSessionFactory`. */
  readonly threadSessions?: Pick<ThreadSessionFactory, 'open'> & Partial<Pick<ThreadSessionFactory, 'pendingTranscripts'>>;
  /** Fleet S5a §3: nax-agent's process-wide credential config; tests inject a spy. Default: nax-agent's own. */
  readonly configureCredentials?: (config: CredentialsConfig) => void;
  /**
   * review-1118 US-001, TEST-ONLY: admit `http:` and `file:` job clone URLs and allow the file transport for this
   * daemon's clone and fetch. A spec's origin is a local path or a loopback HTTP git front; `main.ts` and
   * `commands/run.ts` never set it, so a real runner clones over https only.
   */
  readonly allowLocalCloneUrls?: boolean;
}

export interface DaemonHandle {
  readonly bootId: string;
  readonly journal: Journal;
  readonly supervisor: Supervisor;
  readonly stopped: Promise<StopReason | 'stopped'>;
  stop(): Promise<void>;
  crash(): void;
  /** D102: probe again now (SIGHUP); a changed report is sent on the next sync. Never rejects. */
  reprobe(): Promise<void>;
}

async function pruneJobs(journal: Journal, config: RunnerConfig, log: Logger): Promise<void> {
  const jobsRoot = join(config.workspaceRoot, '.jobs');
  for (const pruned of journal.prune(config.jobRetentionDays)) {
    const jobDir = assertInside(jobsRoot, pruned.jobDir);
    try {
      const entries = await readdir(join(jobDir, 'nax-out'));
      if (entries.length > 0) log.warn('pruning a job directory whose nax-out still has files (cancel-during-upload?)', { jobId: pruned.jobId, count: entries.length });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') log.warn('could not list nax-out before pruning', { jobId: pruned.jobId, error: errorMessage(error) });
    }
    try {
      await rm(jobDir, { recursive: true, force: true });
    } catch (error) {
      log.warn('could not remove a pruned job directory', { jobId: pruned.jobId, error: errorMessage(error) });
    }
  }
}

const SHUTDOWN_NOTICE_MS = 5_000;

/**
 * US-001: the ownership database of a runner home, beside the journal and inside the private home directory.
 * A file of its own, so the owner keeps committing job events to the journal normally and `status` keeps reading it.
 */
export const RUNNER_HOME_LOCK_FILE = 'daemon-lock.db';

/**
 * US-001: a start that may not have the home. `kind` separates a home another live daemon owns from a lock
 * database this process cannot use, so no caller has to match on the message. Both stop the start.
 */
export class HomeOwnershipError extends StartupError {
  constructor(readonly kind: 'occupied' | 'unusable', message: string) {
    super(message);
    this.name = 'HomeOwnershipError';
  }
}

/** US-001: the ownership interval of one home; `release` is idempotent and never throws. */
interface HomeOwnership {
  release(): void;
}

const LOCK_BUSY = /SQLITE_BUSY|SQLITE_LOCKED|database is locked/i;

function isLockBusy(error: unknown): boolean {
  const code = (error as { code?: unknown }).code;
  return (typeof code === 'string' && (code.startsWith('SQLITE_BUSY') || code.startsWith('SQLITE_LOCKED')))
    || LOCK_BUSY.test(errorMessage(error));
}

/**
 * US-001: ownership is a live write transaction on a dedicated connection, so it is the transaction that claims the
 * home, never a pid string, the file's existence or its age. `busy_timeout = 0` makes a contender answer at once
 * instead of waiting behind the owner: a contending invocation does not retry, and a later one retries normally.
 *
 * The diagnostic uses the caller's own spelling of the home, resolved against the working directory: an alias names
 * the home the operator passed, while the lock itself follows the physical directory the alias points at.
 */
async function acquireHomeOwnership(homeDir: string, log: Logger): Promise<HomeOwnership> {
  const absoluteHome = resolve(homeDir);
  const lockPath = join(absoluteHome, RUNNER_HOME_LOCK_FILE);
  let db: Database;
  try {
    db = new Database(lockPath, { create: true });
  } catch (error) {
    throw new HomeOwnershipError('unusable', `cannot open the runner home lock database ${lockPath}: ${errorMessage(error)}`);
  }
  try {
    db.exec('PRAGMA busy_timeout = 0');
    // The table makes the lock database a real database on the first start, so the transaction below always contends
    // on the file itself rather than on an unused zero-length one.
    db.exec('CREATE TABLE IF NOT EXISTS home_owner (acquired_at TEXT NOT NULL)');
    db.exec('BEGIN IMMEDIATE');   // held for the whole ownership interval; nothing is ever committed
  } catch (error) {
    try { db.close(); } catch { /* the connection is being refused anyway */ }
    if (isLockBusy(error)) throw new HomeOwnershipError('occupied', `Runner home is already in use: ${absoluteHome}`);
    throw new HomeOwnershipError('unusable', `cannot use the runner home lock database ${lockPath}: ${errorMessage(error)}`);
  }
  // SEC-1: the same mode as the journal — it holds no secrets, but it sits in the home the journal lives in.
  await chmod(lockPath, 0o600).catch(() => undefined);
  let released = false;
  return {
    release: () => {
      if (released) return;
      released = true;
      try {
        db.exec('ROLLBACK');
      } catch (error) {
        log.warn('could not roll back the runner home lock', { error: errorMessage(error) });
      }
      try {
        db.close();   // closing drops the OS lock with the connection, and rolls the transaction back with it
      } catch (error) {
        log.warn('could not close the runner home lock database', { error: errorMessage(error) });
      }
    },
  };
}

/** US-001: how a start lets go of one resource it opened; it never throws at the caller. */
type StartupResource = () => Promise<void> | void;

/**
 * US-001: retire what a failed start opened, newest first, so the journal (opened first) closes last. Every entry is
 * attempted: one resource that cannot be released must not leave the others open on a home another daemon will take.
 */
async function retireStartup(opened: readonly StartupResource[], log: Logger): Promise<void> {
  for (const retire of [...opened].reverse()) {
    try {
      await retire();
    } catch (error) {
      log.warn('could not retire a resource of the failed start', { error: errorMessage(error) });
    }
  }
}

export async function startDaemon(options: DaemonOptions): Promise<DaemonHandle> {
  const { home } = options;
  const tuning: Tuning = { ...TUNING, ...options.tuning };
  const log = options.log ?? createConsoleLogger();
  const now = options.now ?? systemNow;
  const sleep = options.sleep ?? systemSleep;
  const git = options.git ?? createGit();
  await assertMinGitVersion(git);   // D69: refuse to start before anything is created
  // SEC-1: the home dir holds the journal (which carries clone URLs and runner metadata) — match identity.json's
  // 0o700 so a local user on a multi-tenant host cannot list the directory.
  await mkdir(home.dir, { recursive: true, mode: 0o700 });
  await chmod(home.dir, 0o700).catch(() => undefined);
  // US-001: one live daemon per physical home. Taken after the Git preflight and the home-directory preparation, and
  // before every daemon-owned startup side effect: workspace preparation, log rotation, socket preparation, the
  // writable journal and sync. A failure below relinquishes it once what this attempt opened has been retired.
  const ownership = await acquireHomeOwnership(home.dir, log);
  const opened: StartupResource[] = [];
  try {
    return await startOwnedDaemon(options, ownership, { tuning, log, now, sleep, git }, opened);
  } catch (error) {
    // US-001: partial startup cleanup happens here, before the home is handed back: a start that failed after the
    // journal opened must not leave that connection (or a relay, a socket, an upload or the sync loop) open on a home
    // the replacement is about to take. The order is the entry point's: retire, then release.
    await retireStartup(opened, log);
    ownership.release();
    throw error;
  }
}

/** US-001: the daemon proper; it runs only while `ownership` holds the home, and releases it when it retires. */
async function startOwnedDaemon(
  options: DaemonOptions,
  ownership: HomeOwnership,
  runner: { readonly tuning: Tuning; readonly log: Logger; readonly now: Now; readonly sleep: Sleep; readonly git: Git },
  /** What this attempt opens, in the order it opens it: the entry point's cleanup retires them if it fails. */
  opened: StartupResource[],
): Promise<DaemonHandle> {
  const { config, identity, home } = options;
  const { tuning, log, now, sleep, git } = runner;
  await mkdir(join(config.workspaceRoot, '.jobs'), { recursive: true });
  // OPS-1: launchd appends every stdout/stderr line to runner.log and never rotates it, so the daemon bounds it
  // here and every `runnerLogCheckMs`. A rotation failure (a directory in the way, permissions, a full disk) is a
  // warning: runner.log is not worth stopping the daemon for.
  const rotateLog = async (): Promise<void> => {
    try {
      await rotateLogFile(join(home.dir, 'runner.log'), tuning.runnerLogMaxBytes);
    } catch (error) {
      log.warn('could not rotate runner.log', { error: errorMessage(error) });
    }
  };
  await rotateLog();
  const uid = process.getuid?.() ?? 0;
  const socketDir = config.socketDir ?? defaultSocketDir(uid);
  await ensureSocketDir(socketDir, uid);

  const journal = Journal.open(home.journalPath, now);
  opened.push(() => { journal.close(); });   // pushed first: the journal retires last
  const approvals = new ApprovalRelay({ journal, log, now });
  opened.push(() => { approvals.stopAll(); });
  const bootId = options.bootId ?? newBootId();
  journal.setMeta('boot_id', bootId);
  journal.setMeta('runner_id', identity.runnerId);
  // #518: a daemon killed outright (SIGKILL, OOM, a host crash) leaves its thread backends' process groups running,
  // and no thread session survives a restart. This daemon owns the home now, so it kills them before taking work,
  // then records every process its own backends start.
  const hostBoot = await readHostBootId();
  if (hostBoot === '') log.warn('cannot read the host boot identity; thread backend processes left by an earlier boot are not killed');
  await reapPreviousBootProcesses({ journal, bootId, hostBoot, log });
  const ownedProcesses = new OwnedProcessLedger({ journal, bootId, hostBoot, nowMs: Date.now, log });
  const restoreProcessRecording = installProcessRecording(ownedProcesses);
  opened.push(restoreProcessRecording);
  // Fleet S5a §3: nax-agent reads the credential store through this process-wide config, so a thread session
  // sees the runner's nax home. Once, before the first sync — never the runner's own key or a git token.
  (options.configureCredentials ?? defaultConfigureCredentials)(naxCredentialsConfig(config.naxHome));
  const nax = options.nax ?? createNaxCli(config.naxCommand, config.naxHome, tuning.naxCallTimeoutMs);
  const naxMode = config.capabilities === null;   // D95: this runner asks nax; runner.json carries no capabilities block
  // D84, C10 US-010: the argv the broker hands a shim, the git helper and nax's exec helper, and the same argv the
  // probe compares `<naxHome>/config.json` against. Nothing here edits that file.
  const self = options.selfCommand ?? selfCommand();
  const reporter = new CapabilityReporter(
    createCapabilityProbe(config, now, nax, options.acpProbe, () => vaultHelperEnabled(config.naxHome, self)), journal, log,
  );
  // US-001: no cleanup of its own — a probe or trust failure is retired with everything else by the entry point.
  await reporter.refresh();   // D97, D102: nax missing or older than 0.83.1 stops the start
  if (naxMode) await assertWorkspaceTrusted(nax, config);   // D103
  if (!naxMode) log.warn('capabilities come from runner.json; nax is not probed (remove the block to probe nax)');
  await sweepOrphanProfiles(config.naxHome, new Set(journal.activeJobs().map((job) => job.jobId)));
  approvals.sweepOrphans(journal.activeJobs());
  await pruneJobs(journal, config, log);
  // Fleet S5a §3: the latest sync's archived thread ids (an absent field keeps the previous list); the prune
  // pass runs at start and every `pruneIntervalMs`. A throw is a warning — it never stops the daemon.
  const mutex = new RepoMutex();
  const worktrees = new ThreadWorktreeOwners((threadId, stage, error) => {
    const message = stage === 'shutdown' ? 'thread backend shutdown failed; retaining its worktree' : 'thread final transcript save failed';
    log.error(message, { threadId, error: errorMessage(error) });
  });
  let archivedThreadIds: readonly string[] = [];
  /**
   * Review B1: the live THREAD job ids. The mirror prune reads this again under each mirror's mutex, so a job
   * assigned while the sweep runs — it journals its row, then pins under that same mutex — is never mistaken for an
   * abandoned pin whose `gc` would drop the objects a live session reads.
   */
  const activeThreadJobIds = (): ReadonlySet<string> =>
    new Set(journal.activeJobs().filter((job) => job.command === 'THREAD').map((job) => job.jobId));
  const pruneThreadAssets = async (): Promise<void> => {
    try {
      await pruneProjectCode({
        git, mutex, homeDir: home.dir, nowMs: now().getTime(), ttlMs: tuning.projectCodeMirrorTtlMs,
        activeJobIds: activeThreadJobIds(), currentActiveJobIds: activeThreadJobIds,
      });
    } catch (error) {
      log.warn('project code prune failed', { error: errorMessage(error) });
    }
    try {
      await pruneThreads({
        git, homeDir: home.dir, archivedThreadIds, now,
        activeThreadIds: [...worktrees.activeIds(), ...journal.activeJobs()
          .filter((job) => job.command === 'THREAD')
          .flatMap((job) => (job.assign.thread ? [job.assign.thread.threadId] : []))],
      });
    } catch (error) {
      log.warn('thread prune failed', { error: errorMessage(error) });
    }
  };
  await pruneThreadAssets();

  const client = new ServerClient({ serverUrl: config.serverUrl, apiKey: identity.apiKey, fetchFn: options.fetchFn, syncTimeoutMs: tuning.syncTimeoutMs });
  const capacity = new CapacityTracker(client, log);
  await capacity.refresh();
  const tokens = new TokenCache({ refreshMarginMs: tuning.tokenRefreshMarginMs, cooldownMs: tuning.tokenCooldownMs });
  // US-008: the provider keys handed out over sync, in memory only, like the tokens.
  const providerKeys = new ProviderKeyCache({ refreshMarginMs: tuning.providerKeyRefreshMarginMs });
  const broker = new CredentialBroker({
    tokens, providerKeys, socketDir, runnerId: identity.runnerId, selfCommand: self,
    nowMs: () => Date.now(), sleep,
    timing: { waitMs: tuning.tokenWaitMs, serveWaitMs: tuning.tokenServeWaitMs, pollMs: tuning.tokenPollMs, providerKeyWaitMs: tuning.providerKeyServeWaitMs },
    uid,
  });
  opened.push(() => broker.closeAll());

  // C10 US-009: `providerKey` resolves a provider through the job's own provider-key socket, so the post-checkout check
  // does not refuse a vault-only job for a key koda holds (branch review B1).
  // #406: a check that only timed out (a busy host) is asked again before the job fails.
  // Review B2: in static mode (D104) nax is never asked, but the job profile still forces the sandbox on for RUN,
  // REVIEW, FIX and AGENT, so the machine's own configured report must satisfy that requirement before nax spawns.
  const jobCheck: JobCheck = naxMode
    ? new RetryingJobCheck({
      inner: new NaxJobCheck({
        nax, capabilities: () => reporter.latest(), timeoutMs: tuning.jobCheckTimeoutMs,
        providerKey: (job, providerId) => broker.providerKeyGranted(job, providerId),
      }),
      retries: tuning.jobCheckRetries, backoffMs: tuning.jobCheckRetryBackoffMs, sleep,
    })
    : new StaticJobCheck({ capabilities: () => reporter.latest() });
  const executor = options.executorFactory?.(broker) ?? new HostExecutor({
    config, git, log, nowMs: () => now().getTime(), sleep, credentials: broker, approvals, jobCheck,
    // review-1118 US-001: test-only; unset in production, where a job clones over https only.
    allowLocalCloneUrls: options.allowLocalCloneUrls === true,
  });
  const uploader: BundleUploader = {
    upload: (job, file, rebuild) => uploadWithRetry({
      upload: ({ jobId, leaseEpoch, file: f }) => client.uploadBundle({ jobId, leaseEpoch, filePath: f.path, sha256: f.sha256 }),
      rebuild, sleep, log,
    }, job.jobId, job.leaseEpoch, file),
  };
  // S2a §2.4 (plan D321, D328): one shipper for every job; only this transport talks to the server.
  const shipper = new LogShipper({
    transport: { putLog: (args) => client.putLog(args) },
    log, nowMs: () => now().getTime(), sleep, random: Math.random,
    tuning: { chunkBytes: tuning.logChunkBytes, maxInFlight: tuning.logMaxInFlight, putTimeoutMs: tuning.logPutTimeoutMs, backoffMaxMs: tuning.logBackoffMaxMs },
  });
  opened.push(() => shipper.close());
  // Fleet S5a §3: the thread host. `threadSessions` is the session factory (or a test's fake); the native
  // models a session may name come from the nax home, filtered by the last capability report.
  const sessions = naxMode ? (options.threadSessions ?? new ThreadSessionFactory({
    homeDir: home.dir, naxHome: config.naxHome,
    nativeModels: threadNativeModels(config.naxHome, () => reporter.latest()),
    selfCommand: self,
    processes: ownedProcesses,
  })) : undefined;
  const threads: ThreadRunSetup | undefined = sessions ? {
    host: {
      sessions, worktrees,
      credentials: broker, repoCredentials: broker, git, homeDir: home.dir, workspaceRoot: config.workspaceRoot,
      // Fleet S5b §1: the session's koda tool proxies reach the API through this client; nothing else leaves the runner.
      kodaTools: { call: (args) => client.callKodaTool(args) },
      // review-1118 US-001: test-only, the same value the executor got.
      allowLocalCloneUrls: options.allowLocalCloneUrls === true,
    },
    tuning,
  } : undefined;
  const supervisor = new Supervisor({
    journal, executor, mutex, uploader, log, now, sleep,
    tuning: {
      statusPollMs: tuning.statusPollMs, killGraceMs: tuning.killGraceMs, ackPollMs: tuning.ackPollMs, uploadAckWaitMs: tuning.uploadAckWaitMs, logDrainTimeoutMs: tuning.logDrainTimeoutMs,
      configJobTimeoutMs: tuning.configJobTimeoutMs, configHeartbeatMs: tuning.configHeartbeatMs,
    },
    readoptHeartbeatMs: tuning.readoptHeartbeatMs,
    logs: shipper,
    configEdits: { fetch: (jobId, leaseEpoch) => client.getConfigEdit(jobId, leaseEpoch) },   // S3 §3
    // Fleet S5a §3: only a nax-mode runner hosts threads — a runner.json capabilities block cannot report
    // threadBackends, so its THREAD rows fail `backend_unavailable` in the supervisor.
    ...(threads ? { threads } : {}),
  });
  opened.push(() => { supervisor.shutdown(); });
  /**
   * US-001: an ABANDON's ack is offered when its retirement's outcome is durable. The loop is wired once it exists,
   * so the ack rides a later request instead of being lost.
   */
  const deferredAck: { sink: (ack: CommandAck) => void } = { sink: () => undefined };
  const handler = new CommandHandler({
    journal, supervisor, workspaceRoot: config.workspaceRoot, log, now, approvals,
    // review-1118 US-001: test-only; a real runner's ASSIGN must carry an https clone URL.
    allowLocalCloneUrls: options.allowLocalCloneUrls === true,
    onDeferredAck: (ack) => { deferredAck.sink(ack); },
  });

  let stopReason: StopReason | null = null;
  let wakeLoop = (): void => undefined;
  const reprobe = async (): Promise<void> => {
    try {
      if (await reporter.refresh()) wakeLoop();
    } catch (error) {
      // D102, Review focus 3: nax upgraded or removed under a running daemon; the last report stays.
      log.warn('capability probe failed; keeping the last report', { error: errorMessage(error) });
    }
  };
  const loop = new SyncLoop({
    client, journal, bootId, daemonVersion: DAEMON_VERSION,
    // Fleet S5a B1-R1: a THREAD job holds no nax slot; the server counts thread slots.
    freeSlots: () => freeSlots(capacity.capacity, journal.activeCountExcluding('THREAD')),
    capabilityReport: () => reporter.report(),
    onCapabilitiesSent: (hash) => reporter.markSent(hash),
    handleCommands: (commands) => handler.handle(commands),
    // US-001: the epochs of a job the server does not know are retired in the background; the poll goes on.
    abandonUnknown: (jobIds) => { for (const id of jobIds) supervisor.retireUnknown(id); },
    tokenRequests: () => tokens.requests(Date.now()),
    // US-008: the provider keys a job's model calls are waiting for, and the server's answer, applied at once.
    providerRequests: () => providerKeys.requests(),
    onProviderKeys: (requested, granted, errors) => {
      providerKeys.apply(requested, granted, errors);
      for (const error of errors) log.warn('provider key refused', { jobId: error.jobId, providerId: error.providerId, reason: error.reason });
    },
    onArchivedThreads: (ids) => { archivedThreadIds = [...ids]; },
    onReprobe: () => { void reprobe(); },
    onTokens: (requested, granted, errors) => {
      tokens.apply(requested, granted, errors, Date.now());
      for (const error of errors) log.warn('git token refused', { jobId: error.jobId, reason: error.reason });
    },
    onStop: (reason) => {
      stopReason = reason;
      log.error(reason.kind === 'protocol' ? 'server does not support this runner protocol; stopped' : 'server rejected the runner key; stopped', { message: reason.message });
    },
    log, sleep, random: Math.random, nowMs: () => performance.now(), minGapMs: tuning.syncMinGapMs,
  });
  wakeLoop = () => loop.wake();
  deferredAck.sink = (ack) => { loop.queueAck(ack); };
  const stopNeedListener = tokens.onNeed(() => loop.wake());
  const stopProviderKeyNeedListener = providerKeys.onNeed(() => loop.wake());   // US-008: a new request wakes the poll
  const running = loop.run().then((): StopReason | 'stopped' => stopReason ?? 'stopped');
  opened.push(async () => {
    stopNeedListener();
    stopProviderKeyNeedListener();
    loop.stop();
    await running;
  });

  // One outstanding invocation of each filesystem task. Clearing an interval prevents future
  // ticks, but its last invocation can still be copying the log or pruning a mirror.
  const housekeeping = new Map<() => Promise<void>, Promise<void>>();
  const pendingHomeWork = (): Promise<void>[] => {
    const pending = [...housekeeping.values(), ...worktrees.pending()];
    const transcript = sessions?.pendingTranscripts?.();
    if (transcript) pending.push(transcript);
    return pending;
  };
  const runHousekeeping = (task: () => Promise<void>): void => {
    if (housekeeping.has(task)) return;
    const done = task()
      .catch((error: unknown) => { log.warn('runner housekeeping failed', { error: errorMessage(error) }); })
      .finally(() => { housekeeping.delete(task); });
    housekeeping.set(task, done);
  };
  const pruneJobDirs = () => pruneJobs(journal, config, log);
  const timers = [
    setInterval(() => { void capacity.refresh(); }, tuning.capacityRefreshMs),
    setInterval(() => { runHousekeeping(pruneJobDirs); runHousekeeping(pruneThreadAssets); }, tuning.pruneIntervalMs),
    setInterval(() => { void reprobe(); }, tuning.capabilityProbeMs),
    setInterval(() => { runHousekeeping(rotateLog); }, tuning.runnerLogCheckMs),
  ];
  for (const timer of timers) timer.unref();
  const stopTimers = (): void => { for (const timer of timers) clearInterval(timer); };
  opened.push(async () => {
    stopTimers();
    await Promise.all(housekeeping.values());
  });

  let stopping: Promise<void> | null = null;
  let crashed = false;
  const stop = (): Promise<void> => {
    if (crashed) return stopping ?? Promise.resolve();
    stopping ??= (async () => {
      stopTimers();
      loop.stop();
      stopNeedListener();
      stopProviderKeyNeedListener();
      await running;
      supervisor.shutdown();
      await shipper.close();
      approvals.stopAll();   // no new asks are accepted while runs drain; READOPT re-binds on the next boot
      await broker.closeAll();   // D90: sockets close; a prepare waiting for its first token ends now instead of in 120 s
      // D67: a halted run ends at its next check, or when its current executor call returns. The journal must outlive it.
      const notice = setTimeout(() => log.warn('waiting for halted job runs to end before closing the journal'), SHUTDOWN_NOTICE_MS);
      try {
        await supervisor.idle();
        // US-001: the command-outcome writers settle too: a retiring ABANDON writes its outcome after its cleanup,
        // and that write must reach the journal before the journal closes.
        await handler.idle();
        await Promise.all(pendingHomeWork());
      } finally {
        clearTimeout(notice);
      }
      restoreProcessRecording();   // #518: every session has closed; a later spawn is no thread backend's
      journal.close();
      // US-001: the home is held through the last journal writer, and only then released. A stop repeated on this
      // retired handle is a no-op above, so it can never release a successor's ownership.
      ownership.release();
    })();
    return stopping;
  };
  /** D40, D67: the in-process stand-in for `kill -9` of the daemon. Nothing is drained and no child is signalled. */
  const crash = (): void => {
    if (crashed || stopping) return;
    crashed = true;
    stopTimers();
    loop.stop();
    stopNeedListener();
    stopProviderKeyNeedListener();
    supervisor.shutdown();   // a real kill ends every run; in one process they must at least stop emitting
    void shipper.close();   // a killed daemon's uploads die with it; the next daemon resumes at the server's size (R3)
    approvals.stopAll();   // a killed daemon's listeners die with it; READOPT re-binds on the next boot
    void broker.closeAll();   // D90: a killed daemon's listeners die with it; the files stay (the next daemon replaces them)
    restoreProcessRecording();   // #518: the ledger rows stay for the next daemon to reap; only this process stops recording
    journal.close();
    // A real process death stops its housekeeping. The in-process stand-in keeps the
    // lock for any filesystem operation already submitted, even though its journal has closed.
    const pending = pendingHomeWork();
    if (pending.length === 0) ownership.release();
    else stopping = Promise.all(pending).then(() => ownership.release());
  };
  return { bootId, journal, supervisor, stopped: running, stop, crash, reprobe };
}
