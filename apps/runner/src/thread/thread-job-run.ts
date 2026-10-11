import { chmod, mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import type { AgentSession } from '@nathapp/nax-agent';
import type { ThreadAssign, ThreadCommandType } from '@nathapp/fleet-protocol';
import type { CredentialProvider } from '../credentials/broker';
import { errorMessage } from '../errors';
import type { Git } from '../executor/git';
import type { JobRow } from '../journal/types';
import type { LogShipping, ThreadLogJob } from '../logs/types';
import { jobDirFor, repoDirFor } from '../paths/safe-segment';
import { JobEvents } from '../supervisor/job-events';
import type { JobRunDeps, RunStart } from '../supervisor/job-run';
import type { RepoMutex } from '../supervisor/repo-mutex';
import { isTerminalState } from '../supervisor/transitions';
import { ensureSkills as defaultEnsureSkills, type EnsureSkillsOptions } from './skill-fetch';
import type { OpenThreadSessionOptions } from './session-factory';
import { ThreadEventWriter } from './thread-event-writer';
import { prepareThreadWorktree as defaultPrepareThreadWorktree, type PrepareThreadWorktreeInput } from './thread-worktree';
import { buildThreadTools } from './tools';

/** The thread stream file, inside the job's own `.jobs/<jobId>` directory. */
export const THREAD_EVENTS_FILE = 'thread-events.jsonl';

/**
 * A seam input re-spelled as an anonymous object type. An interface carries no implicit index signature, so a
 * seam typed with the interface itself refuses a test double whose parameter is `Record<string, unknown>`; the
 * shape is unchanged — every property keeps its type.
 */
type Seam<T> = { [K in keyof T]: T[K] };

export type ThreadWorktreeInput = Seam<PrepareThreadWorktreeInput>;
export type ThreadSkillsInput = Seam<EnsureSkillsOptions>;
export type ThreadOpenInput = Seam<OpenThreadSessionOptions>;
export type ThreadLogInput = Seam<ThreadLogJob>;

/**
 * The seams answer what the B3a functions answer, except that a refusal `reason` is a plain string: the run
 * reports it verbatim in the row's FAILED event, and a test double that widens it (`reason: string`) fits.
 */
export type ThreadPrepareResult =
  | { ok: true; worktree: string; tipSha: string }
  | { ok: false; reason: string };

export type ThreadSkillsResult = { ok: true } | { ok: false; reason: string };

/** What `open` answers, widened the same way. */
export type ThreadOpenResult =
  | { ok: true; session: AgentSession; resumed: boolean }
  | { ok: false; reason: string };

/** `ThreadSessionFactory`'s `open`, with its input re-spelled through `Seam`. */
export interface ThreadSessionOpener {
  open(input: ThreadOpenInput): Promise<ThreadOpenResult>;
}

/** What a thread run needs from the runner-wide log shipper: `LogShipping` with its job input re-spelled through `Seam`. */
export type ThreadLogShipping = Omit<LogShipping, 'register'> & { register(job: ThreadLogInput): void };

/** What a thread run needs from the daemon (daemon.ts). */
export interface ThreadHostDeps {
  readonly sessions: ThreadSessionOpener;
  readonly credentials: CredentialProvider;
  readonly git: Git;
  /** RunnerHome.dir: the skill cache lives in `<homeDir>/skills`, the worktrees in `<homeDir>/threads`. */
  readonly homeDir: string;
  readonly workspaceRoot: string;
  /** B3a's `prepareThreadWorktree`; a test supplies its own. */
  readonly prepareWorktree?: (input: ThreadWorktreeInput) => Promise<ThreadPrepareResult>;
  /** B3a's `ensureSkills`; a test supplies its own. */
  readonly ensureSkills?: (input: ThreadSkillsInput) => Promise<ThreadSkillsResult>;
  /** The skills remote's base URL; the default fetches from `https://github.com`. */
  readonly skillOrigin?: string;
}

export interface ThreadRunTuning {
  readonly threadIdleMs: number;
  readonly threadHeartbeatMs: number;
  readonly threadWakeGapMs: number;
  readonly threadSearchTimeoutMs: number;
  readonly threadSkillFetchTimeoutMs: number;
  readonly logDrainTimeoutMs: number;
  readonly threadCloseTimeoutMs: number;
  /** Passed to the writer; default `THREAD_STREAM_LIMITS.streamMaxBytes`. Tests lower it. */
  readonly streamMaxBytes?: number;
}

export interface ThreadRunSetup {
  readonly host: ThreadHostDeps;
  readonly tuning: ThreadRunTuning;
}

/**
 * The run takes no repo mutex of its own — it only hands one to `prepareThreadWorktree` — so the seam is the
 * `acquire` a worktree preparation needs, and `logs` is `LogShipping` with its job input re-spelled (`Seam`).
 */
export type ThreadRunDeps =
  Pick<JobRunDeps, 'journal' | 'log' | 'now' | 'sleep'>
  & { readonly mutex: Pick<RepoMutex, 'acquire'>; readonly logs: ThreadLogShipping }
  & ThreadRunSetup;

export type ThreadCommandOutcome = { result: 'ok' | 'rejected'; detail?: string };

/**
 * Fleet S5a slice B3b: one THREAD job, from ASSIGN to cleanup. It is deliberately not a `JobRun` — a thread
 * spawns no nax, uploads no bundle and owns a worktree of its own, so it takes no repo mutex and reaps no
 * clone. `start` resolves only once the run has ended: a terminal transition and its `markDone`, an abandon
 * or a halt. The Supervisor keeps the run in its map until then, so a command reaches it while it prepares,
 * runs or closes.
 */
export class ThreadJobRun {
  private readonly events: JobEvents;
  private writer: ThreadEventWriter | null = null;
  private session: AgentSession | null = null;
  private halted = false;
  private readonly endWaiters: Array<() => void> = [];

  constructor(private readonly deps: ThreadRunDeps, readonly jobId: string, readonly leaseEpoch: number) {
    this.events = new JobEvents(deps.journal, jobId, leaseEpoch, deps.log);
  }

  private row(): JobRow | null {
    return this.deps.journal.getJob(this.jobId, this.leaseEpoch);
  }

  private cancelRequested(): boolean {
    return this.row()?.cancelRequestedAt != null;
  }

  private skillsRoot(): string {
    return join(this.deps.host.homeDir, 'skills');
  }

  async start(from: RunStart): Promise<void> {
    try {
      await this.run(from);
    } catch (error) {
      await this.failSafe(error);
    } finally {
      // Every exit gives up the job's log streams, including a halt, an abandon and a failure whose own recording failed.
      this.deps.logs.stopJob(this.jobId, this.leaseEpoch);
    }
  }

  private async run(from: RunStart): Promise<void> {
    const row = this.row();
    if (row === null || row.doneAt !== null) return;   // abandoned before the run picked the row up
    if (from === 'watch' || from === 'finish') {
      // A session dies with the daemon that held it: there is nothing to resume.
      await this.failSafe(new Error('a thread job cannot be resumed'));
      return;
    }
    const thread = row.assign.thread;
    if (thread === undefined) {
      await this.failSafe(new Error('thread assignment missing'));
      return;
    }
    if (this.stopped()) return;

    // Step 1: the git credentials, waiting for the job's first token. The wait polls the cancel request and a
    // halt, so an abandon does not sit out the token timeout. A refusal holds the socket, the wanted token and
    // the shims the broker opened before it waited, so it gives them back too — as the RUN path's cleanup does.
    const acquired = await this.deps.host.credentials.acquire(row, { wait: true, isCancelled: () => this.cancelRequested() || this.halted });
    if (this.halted) {
      await this.releaseCredentials(row);
      return;
    }
    if (!acquired.ok) {
      await this.releaseCredentials(row);
      if (acquired.cancelled) this.endBeforeRunning('CANCELLED', 'cancelled before start');
      else this.endBeforeRunning('FAILED', acquired.reason);
      return;
    }
    if (this.stopped()) {
      await this.releaseCredentials(row);
      return;
    }

    // Steps 2-4: the thread's worktree, with the credentials released whatever it returns.
    const prepared = await this.prepare(row, thread, acquired.credentials.helper);
    if (this.stopped()) return;
    if (!prepared.ok) {
      this.endBeforeRunning('FAILED', prepared.reason);
      return;
    }

    // Step 5: the assigned skill sources into the runner's cache.
    const skills = await this.setUpSkills(thread);
    if (this.stopped()) return;
    if (!skills.ok) {
      this.endBeforeRunning('FAILED', skills.reason);
      return;
    }

    // Step 6: the session, on the prepared worktree. A cancel or halt that lands while it opens ends the run
    // as above, and the session `open` then resolved is closed rather than dropped.
    const opened = await this.deps.host.sessions.open({
      jobId: this.jobId,
      thread,
      worktree: prepared.worktree,
      tools: buildThreadTools({
        worktree: prepared.worktree,
        skillsRoot: this.skillsRoot(),
        skills: thread.skills,
        git: this.deps.host.git,
        searchTimeoutMs: this.deps.tuning.threadSearchTimeoutMs,
        nowMs: () => this.deps.now().getTime(),
      }),
      approvalTimeoutSec: row.assign.approvalTimeoutSec,
    });
    if (this.halted) {
      if (opened.ok) await this.closeSession(opened.session);
      return;
    }
    if (this.cancelRequested()) {
      if (opened.ok) await this.closeSession(opened.session);
      this.endBeforeRunning('CANCELLED', 'cancelled before start');
      return;
    }
    if (!opened.ok) {
      this.endBeforeRunning('FAILED', opened.reason);
      return;
    }

    // Steps 7-8: the row goes RUNNING, the stream is created and announced, and the first turn starts.
    this.session = opened.session;
    this.events.transition('RUNNING', undefined, { pid: null, pgid: null, branch: null });
    await this.openStream(thread, opened.resumed);
    this.startInitialTurn(thread);
    await this.waitForEnd();
  }

  /** Every start step begins here: a halt ends the run silently, a cancel request ends it CANCELLED. */
  private stopped(): boolean {
    if (this.halted) return true;
    if (!this.cancelRequested()) return false;
    this.endBeforeRunning('CANCELLED', 'cancelled before start');
    return true;
  }

  /**
   * Steps 2-3: the thread's own worktree, then the credentials go whatever it returned — nothing after this
   * needs git credentials. The thread's feature is the one the ASSIGN carries, never the job's `thread-<id>`.
   */
  private async prepare(row: JobRow, thread: ThreadAssign, credentialHelper: string | null): Promise<ThreadPrepareResult> {
    const prepare = this.deps.host.prepareWorktree ?? defaultPrepareThreadWorktree;
    try {
      return await prepare({
        git: this.deps.host.git,
        mutex: this.deps.mutex,
        repoKey: row.repoKey,
        repoDir: repoDirFor(this.deps.host.workspaceRoot, row.assign.repo.owner, row.assign.repo.name),
        cloneUrl: row.assign.repo.cloneUrl,
        identity: row.assign.gitIdentity,
        credentialHelper,
        homeDir: this.deps.host.homeDir,
        threadId: thread.threadId,
        baseRef: row.assign.ref,
        feature: thread.feature,
      });
    } finally {
      // Step 3: the socket and the shims go whatever the worktree step returned. A release that fails must not
      // mask a clean refusal — a `worktree_conflict` stays that, not a `runner error`.
      await this.releaseCredentials(row);
    }
  }

  /** D90: the job's socket, token and shims go. A release that fails is reported and never changes the outcome. */
  private async releaseCredentials(row: JobRow): Promise<void> {
    try {
      await this.deps.host.credentials.release(row);
    } catch (error) {
      this.deps.log.warn('credential release failed', { jobId: this.jobId, error: errorMessage(error) });
    }
  }

  /** Step 5: the assigned skill sources, fetched into the runner's own skill cache. */
  private setUpSkills(thread: ThreadAssign): Promise<ThreadSkillsResult> {
    const ensure = this.deps.host.ensureSkills ?? defaultEnsureSkills;
    return ensure({
      skills: thread.skills,
      skillsRoot: this.skillsRoot(),
      git: this.deps.host.git,
      timeoutMs: this.deps.tuning.threadSkillFetchTimeoutMs,
      origin: this.deps.host.skillOrigin,
    });
  }

  /** A session the run no longer needs is closed; a throwing `close` is logged, never fatal. */
  private async closeSession(session: AgentSession): Promise<void> {
    try {
      await session.close();
    } catch (error) {
      this.deps.log.warn('thread session close failed', { jobId: this.jobId, error: errorMessage(error) });
    }
  }

  /** The session does not outlive the run: a failure after RUNNING must not leave an agent session alive. */
  private async closeHeldSession(): Promise<void> {
    const session = this.session;
    this.session = null;
    if (session !== null) await this.closeSession(session);
  }

  /**
   * Step 7: the stream file is recreated — it is keyed by job id only, so a requeued epoch must never re-ship
   * the lines of the epoch it replaces — then registered with the shipper and announced to the server.
   */
  private async openStream(thread: ThreadAssign, resumed: boolean): Promise<void> {
    const jobDir = jobDirFor(this.deps.host.workspaceRoot, this.jobId);
    const threadPath = join(jobDir, THREAD_EVENTS_FILE);
    await mkdir(jobDir, { recursive: true, mode: 0o700 });
    await chmod(jobDir, 0o700);   // D93: a requeued epoch reuses the directory, which keeps its old mode
    await rm(threadPath, { force: true });
    const writer = new ThreadEventWriter({
      filePath: threadPath,
      jobId: this.jobId,
      leaseEpoch: this.leaseEpoch,
      logs: this.deps.logs,
      wakeGapMs: this.deps.tuning.threadWakeGapMs,
      now: this.deps.now,
      sleep: this.deps.sleep,
      streamMaxBytes: this.deps.tuning.streamMaxBytes,
      onWarn: (message) => this.events.lifecycle('warn', message),
    });
    this.writer = writer;
    this.deps.logs.register({
      jobId: this.jobId,
      leaseEpoch: this.leaseEpoch,
      threadPath,
      lifecycle: (level, message) => this.events.lifecycle(level, message),
    });
    writer.started({ resumed, backend: thread.backend, skillShas: thread.skills.map((source) => source.sha) });
  }

  /** Step 8: the initial message's turn, off the `start` path; with no initial message the run only waits. */
  private startInitialTurn(thread: ThreadAssign): void {
    const message = thread.initialMessage;
    if (message === null) return;
    void this.runTurn(message.messageId, message.text);
  }

  private async runTurn(messageId: string, text: string): Promise<void> {
    const session = this.session;
    const writer = this.writer;
    if (session === null || writer === null) return;
    try {
      writer.inputConsumed(messageId);
      for await (const event of session.send(text)) writer.event(event);
    } catch (error) {
      await this.failSafe(error);
    }
  }

  /** The promise `start` resolves on covers the whole run: it resolves on a halt, an abandon or a terminal end. */
  private async waitForEnd(): Promise<void> {
    if (this.halted) return;
    await new Promise<void>((resolve) => this.endWaiters.push(resolve));
  }

  private releaseEnd(): void {
    for (const resolve of this.endWaiters.splice(0)) resolve();
  }

  /** A failure or a cancellation before RUNNING: the row is told and marked done, and no stream line is written. */
  private endBeforeRunning(to: 'FAILED' | 'CANCELLED', reason: string): void {
    this.events.transition(to, reason);
    this.deps.journal.markDone(this.jobId, this.leaseEpoch);
  }

  /** A throw in `start` still ends the job legally: RUNNING has no direct way to FAILED. */
  private async failSafe(error: unknown): Promise<void> {
    if (this.halted) return;
    this.deps.log.error('thread run failed', { jobId: this.jobId, error: errorMessage(error) });
    try {
      if (this.events.currentState() === 'RUNNING') {
        this.events.lifecycle('error', `runner error: ${errorMessage(error)}`);
        this.events.transition('UPLOADING');
        this.events.transition('FAILED', 'session_error');
      } else {
        this.events.transition('FAILED', `runner error: ${errorMessage(error)}`);
      }
      this.deps.journal.markDone(this.jobId, this.leaseEpoch);
    } catch (inner) {
      this.deps.log.error('thread failure could not be recorded', { jobId: this.jobId, error: errorMessage(inner) });
    } finally {
      await this.closeHeldSession();
      this.releaseEnd();
    }
  }

  /** B3b-R2: the answer is synchronous — a command never waits on the session before it is acknowledged. */
  command(_type: ThreadCommandType, _payload: unknown): ThreadCommandOutcome {
    return { result: 'rejected', detail: 'unsupported' };
  }

  requestCancel(): boolean {
    const row = this.row();
    if (row === null || isTerminalState(row.state)) return false;
    if (row.cancelRequestedAt === null) {
      this.deps.journal.updateJob(this.jobId, this.leaseEpoch, { cancelRequestedAt: this.deps.now().toISOString() });
    }
    return true;
  }

  halt(): void {
    this.halted = true;
    this.deps.logs.stopJob(this.jobId, this.leaseEpoch);
    this.releaseEnd();
  }

  async abandon(): Promise<void> {
    this.halt();
    this.deps.journal.abandon(this.jobId, this.leaseEpoch);
  }
}
