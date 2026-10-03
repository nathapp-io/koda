import { chmod, mkdir, readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { uploadWithRetry } from '../bundle/upload-bundle';
import { ApprovalRelay } from '../approvals/approval-relay';
import { CapabilityReporter } from '../capabilities/capability-probe';
import { createCapabilityProbe } from '../capabilities/create-probe';
import { NaxJobCheck } from '../capabilities/job-check';
import type { RunnerConfig, RunnerHome } from '../config/runner-config';
import { errorMessage } from '../errors';
import { CredentialBroker } from '../credentials/broker';
import { TokenCache } from '../credentials/token-cache';
import { defaultSocketDir, ensureSocketDir } from '../credentials/socket-dir';
import { HostExecutor } from '../executor/host-executor';
import { assertMinGitVersion, createGit, type Git } from '../executor/git';
import type { JobExecutor } from '../executor/job-executor';
import { sweepOrphanProfiles } from '../executor/job-profile';
import { newBootId, type RunnerIdentityFile } from '../identity/identity-store';
import { Journal } from '../journal/journal';
import { createConsoleLogger, type Logger } from '../logger';
import { createNaxCli, type NaxCli } from '../nax/nax-cli';
import { assertWorkspaceTrusted } from '../nax/trust';
import { assertInside } from '../paths/safe-segment';
import { selfCommand } from '../self-command';
import { CommandHandler } from '../supervisor/command-handler';
import { RepoMutex } from '../supervisor/repo-mutex';
import { Supervisor } from '../supervisor/supervisor';
import type { BundleUploader } from '../supervisor/job-run';
import { ServerClient, type FetchFn } from '../sync/http';
import { SyncLoop, type StopReason } from '../sync/sync-loop';
import { systemNow, systemSleep, type Now, type Sleep } from '../time';
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
  readonly executorFactory?: () => JobExecutor;
  readonly git?: Git;
  /** D84: how git and the shims run this runner; tests pass ['bun', <src/main.ts>]. */
  readonly selfCommand?: readonly string[];
  /** D96: tests inject a scripted nax; otherwise `createNaxCli(config.naxCommand, config.naxHome)`. */
  readonly nax?: NaxCli;
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

export async function startDaemon(options: DaemonOptions): Promise<DaemonHandle> {
  const { config, identity, home } = options;
  const tuning: Tuning = { ...TUNING, ...options.tuning };
  const log = options.log ?? createConsoleLogger();
  const now = options.now ?? systemNow;
  const sleep = options.sleep ?? systemSleep;
  const git = options.git ?? createGit();
  await assertMinGitVersion(git);   // D69: refuse to start before anything is created
  await mkdir(join(config.workspaceRoot, '.jobs'), { recursive: true });
  // SEC-1: the home dir holds the journal (which carries clone URLs and runner metadata) — match identity.json's
  // 0o700 so a local user on a multi-tenant host cannot list the directory.
  await mkdir(home.dir, { recursive: true, mode: 0o700 });
  await chmod(home.dir, 0o700).catch(() => undefined);
  const uid = process.getuid?.() ?? 0;
  const socketDir = config.socketDir ?? defaultSocketDir(uid);
  await ensureSocketDir(socketDir, uid);   // D78: refuse to start before anything could listen in an unsafe place

  const journal = Journal.open(home.journalPath, now);
  const approvals = new ApprovalRelay({ journal, log, now });
  const bootId = options.bootId ?? newBootId();
  journal.setMeta('boot_id', bootId);
  journal.setMeta('runner_id', identity.runnerId);
  const nax = options.nax ?? createNaxCli(config.naxCommand, config.naxHome, tuning.naxCallTimeoutMs);
  const naxMode = config.capabilities === null;   // D95: this runner asks nax; runner.json carries no capabilities block
  const reporter = new CapabilityReporter(createCapabilityProbe(config, now, nax), journal, log);
  try {
    await reporter.refresh();   // D97, D102: nax missing or older than 0.83.1 stops the start
    if (naxMode) await assertWorkspaceTrusted(nax, config);   // D103
  } catch (error) {
    journal.close();
    throw error;
  }
  if (!naxMode) log.warn('capabilities come from runner.json; nax is not probed (remove the block to probe nax)');
  await sweepOrphanProfiles(config.naxHome, new Set(journal.activeJobs().map((job) => job.jobId)));
  approvals.sweepOrphans(journal.activeJobs());
  await pruneJobs(journal, config, log);

  const client = new ServerClient({ serverUrl: config.serverUrl, apiKey: identity.apiKey, fetchFn: options.fetchFn, syncTimeoutMs: tuning.syncTimeoutMs });
  const capacity = new CapacityTracker(client, log);
  await capacity.refresh();
  const tokens = new TokenCache({ refreshMarginMs: tuning.tokenRefreshMarginMs, cooldownMs: tuning.tokenCooldownMs });
  const broker = new CredentialBroker({
    tokens, socketDir, runnerId: identity.runnerId, selfCommand: options.selfCommand ?? selfCommand(),
    nowMs: () => Date.now(), sleep,
    timing: { waitMs: tuning.tokenWaitMs, serveWaitMs: tuning.tokenServeWaitMs, pollMs: tuning.tokenPollMs },
    uid,
  });

  const jobCheck = naxMode ? new NaxJobCheck({ nax, capabilities: () => reporter.latest(), timeoutMs: tuning.jobCheckTimeoutMs }) : undefined;   // D104
  const executor = options.executorFactory?.() ?? new HostExecutor({
    config, git, log, nowMs: () => now().getTime(), sleep, credentials: broker, approvals, ...(jobCheck ? { jobCheck } : {}),
  });
  const uploader: BundleUploader = {
    upload: (job, file, rebuild) => uploadWithRetry({
      upload: ({ jobId, leaseEpoch, file: f }) => client.uploadBundle({ jobId, leaseEpoch, filePath: f.path, sha256: f.sha256 }),
      rebuild, sleep, log,
    }, job.jobId, job.leaseEpoch, file),
  };
  const supervisor = new Supervisor({
    journal, executor, mutex: new RepoMutex(), uploader, log, now, sleep,
    tuning: { statusPollMs: tuning.statusPollMs, killGraceMs: tuning.killGraceMs, ackPollMs: tuning.ackPollMs, uploadAckWaitMs: tuning.uploadAckWaitMs },
    readoptHeartbeatMs: tuning.readoptHeartbeatMs,
  });
  const handler = new CommandHandler({ journal, supervisor, workspaceRoot: config.workspaceRoot, log, now });

  let stopReason: StopReason | null = null;
  const loop = new SyncLoop({
    client, journal, bootId, daemonVersion: DAEMON_VERSION,
    freeSlots: () => freeSlots(capacity.capacity, journal.activeCount()),
    capabilityReport: () => reporter.report(),
    onCapabilitiesSent: (hash) => reporter.markSent(hash),
    handleCommands: (commands) => handler.handle(commands),
    abandonUnknown: async (jobIds) => { for (const id of jobIds) await supervisor.abandonAll(id); },
    tokenRequests: () => tokens.requests(Date.now()),
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
  const stopNeedListener = tokens.onNeed(() => loop.wake());
  const running = loop.run().then((): StopReason | 'stopped' => stopReason ?? 'stopped');

  const reprobe = async (): Promise<void> => {
    try {
      if (await reporter.refresh()) loop.wake();
    } catch (error) {
      // D102, Review focus 3: nax upgraded or removed under a running daemon; the last report stays.
      log.warn('capability probe failed; keeping the last report', { error: errorMessage(error) });
    }
  };

  const timers = [
    setInterval(() => { void capacity.refresh(); }, tuning.capacityRefreshMs),
    setInterval(() => { void pruneJobs(journal, config, log); }, tuning.pruneIntervalMs),
    setInterval(() => { void reprobe(); }, tuning.capabilityProbeMs),
  ];
  for (const timer of timers) timer.unref();

  let stopping: Promise<void> | null = null;
  let crashed = false;
  const stop = (): Promise<void> => {
    if (crashed) return Promise.resolve();
    stopping ??= (async () => {
      for (const timer of timers) clearInterval(timer);
      loop.stop();
      stopNeedListener();
      await running;
      supervisor.shutdown();
      approvals.stopAll();   // no new asks are accepted while runs drain; READOPT re-binds on the next boot
      await broker.closeAll();   // D90: sockets close; a prepare waiting for its first token ends now instead of in 120 s
      // D67: a halted run ends at its next check, or when its current executor call returns. The journal must outlive it.
      const notice = setTimeout(() => log.warn('waiting for halted job runs to end before closing the journal'), SHUTDOWN_NOTICE_MS);
      try {
        await supervisor.idle();
      } finally {
        clearTimeout(notice);
      }
      journal.close();
    })();
    return stopping;
  };
  /** D40, D67: the in-process stand-in for `kill -9` of the daemon. Nothing is drained and no child is signalled. */
  const crash = (): void => {
    if (crashed || stopping) return;
    crashed = true;
    for (const timer of timers) clearInterval(timer);
    loop.stop();
    stopNeedListener();
    supervisor.shutdown();   // a real kill ends every run; in one process they must at least stop emitting
    approvals.stopAll();   // a killed daemon's listeners die with it; READOPT re-binds on the next boot
    void broker.closeAll();   // D90: a killed daemon's listeners die with it; the files stay (the next daemon replaces them)
    journal.close();
  };
  return { bootId, journal, supervisor, stopped: running, stop, crash, reprobe };
}
