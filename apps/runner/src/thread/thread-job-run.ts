import { chmod, mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import type { AgentSession, EmbedderTool, SessionEvent } from '@nathapp/nax-agent';
import { THREAD_LIMITS, type ThreadAssign, type ThreadCommandType } from '@nathapp/fleet-protocol';
import type { CredentialProvider } from '../credentials/broker';
import { errorMessage } from '../errors';
import type { Git } from '../executor/git';
import type { JobRow } from '../journal/types';
import type { DrainResult, LogShipping, ThreadLogJob } from '../logs/types';
import { assertSegment, jobDirFor, repoDirFor } from '../paths/safe-segment';
import { JobEvents } from '../supervisor/job-events';
import type { JobRunDeps, RunStart } from '../supervisor/job-run';
import type { RepoMutex } from '../supervisor/repo-mutex';
import { publishThreadDocs, type PublishThreadDocsInput } from './thread-publish';
import { ThreadLivePublish, publishInputMutex } from './thread-live-publish';
import { runThreadAction, type ThreadDiscardInput, type ThreadDiscardResult } from './thread-action-run';
import { isTerminalState } from '../supervisor/transitions';
import { ensureSkills as defaultEnsureSkills, type EnsureSkillsOptions } from './skill-fetch';
import type { OpenThreadSessionOptions } from './session-factory';
import { ThreadEventWriter } from './thread-event-writer';
import { prepareThreadWorktree as defaultPrepareThreadWorktree, type PrepareThreadWorktreeInput } from './thread-worktree';
import { threadScratchDir } from './thread-paths';
import { buildKodaToolProxies, type KodaToolCaller } from './tools/koda-proxies';
import { buildProjectThreadTools, buildThreadTools } from './tools';

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
export type ThreadPublishInput = Seam<PublishThreadDocsInput>;
export type ThreadPublishResult = { ok: true; sha: string; paths: string[]; ignored: string[]; specPresent: boolean } | { ok: false; reason: string; detail?: string };

/**
 * The seams answer what the B3a functions answer, except that a refusal `reason` is a plain string: the run
 * reports it verbatim in the row's FAILED event, and a test double that widens it (`reason: string`) fits.
 */
export type ThreadPrepareResult =
  | { ok: true; worktree: string; tipSha: string; stale?: boolean }
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
  /** An alternate publisher must check `publishedLineFits` before committing; the writer's size guard only runs afterwards. */
  readonly publish?: (input: ThreadPublishInput) => Promise<ThreadPublishResult>;
  readonly discard?: (input: ThreadDiscardInput) => Promise<ThreadDiscardResult>;
  /** The skills remote's base URL; the default fetches from `https://github.com`. */
  readonly skillOrigin?: string;
  /**
   * Fleet S5b US-006: the API's koda tools, proxied into a session whose ASSIGN carries `thread.kodaTools`.
   * Absent, the session keeps the kind's own tools and reaches no koda data.
   */
  readonly kodaTools?: KodaToolCaller;
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
  & { readonly mutex: Pick<RepoMutex, 'acquire'> & Partial<Pick<RepoMutex, 'isLocked'>>; readonly logs: ThreadLogShipping }
  & ThreadRunSetup;

export type ThreadCommandOutcome = { result: 'ok' | 'rejected'; detail?: string };

/** B3b-R3: the reasons a live thread run closes itself with; the first one that arrives wins. */
type ThreadCloseReason = 'idle' | 'closed' | 'cost_cap' | 'stream_cap' | 'cancelled';

/** The one reason a turn's own failure ends the run with. */
const SESSION_ERROR = 'session_error';

/** The ask transport's request-id rule: 1..200 printable ASCII characters. */
const REQUEST_ID_RE = /^[\x20-\x7e]{1,200}$/;

/** A string of at most `messageMaxBytes` UTF-8 bytes — the bound the API applies to a message and an answer. */
function isMessageText(value: unknown): value is string {
  return typeof value === 'string' && Buffer.byteLength(value, 'utf8') <= THREAD_LIMITS.messageMaxBytes;
}

/** A safe path segment: the same rule every path built from server data goes through. */
function isSafeSegment(value: unknown): value is string {
  try {
    assertSegment('messageId', value);
    return true;
  } catch {
    return false;
  }
}

/** The `THREAD_INPUT` payload, or null when it is not exactly `{ messageId, text }` with a usable id and text. */
function readInput(payload: unknown): { messageId: string; text: string } | null {
  if (typeof payload !== 'object' || payload === null) return null;
  const { messageId, text } = payload as { messageId?: unknown; text?: unknown };
  return isSafeSegment(messageId) && isMessageText(text) ? { messageId, text } : null;
}

/** The `THREAD_ANSWER` payload, or null when it is not exactly `{ requestId, text }` with a usable id and text. */
function readAnswer(payload: unknown): { requestId: string; text: string } | null {
  if (typeof payload !== 'object' || payload === null) return null;
  const { requestId, text } = payload as { requestId?: unknown; text?: unknown };
  return typeof requestId === 'string' && REQUEST_ID_RE.test(requestId) && isMessageText(text) ? { requestId, text } : null;
}

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
  private livePublish: ThreadLivePublish | null = null;
  private halted = false;
  private readonly endWaiters: Array<() => void> = [];
  private ended = false;
  /** A turn's iteration is in flight: the idle timer is stopped and a close waits for it to end. */
  private turnRunning = false;
  private turnSettled: Promise<void> = Promise.resolve();
  private turnDone: (() => void) | null = null;
  /** The one-shot idle timer's abort, while it is armed. */
  private idleAbort: AbortController | null = null;
  /** The heartbeat's abort, while it is armed. */
  private heartbeatAbort: AbortController | null = null;
  /**
   * The session close, started once per run by `halt`, `closeSession` or `closeHeldSession`. Every wait on it is
   * bounded by `threadCloseTimeoutMs`, so a close that timed out may still outlive the run.
   */
  private sessionClose: Promise<void> | null = null;
  /** B3b-R3: set synchronously when a close or a fail is requested; a later reason is ignored. */
  private closing = false;
  /** Cost is the sum of `usage.costUsd` over the whole job (a `turn_end.costUsd` repeats its turn's usage). */
  private spent = 0;
  private maxCostUsd = Number.POSITIVE_INFINITY;

  private readonly deps: ThreadRunDeps;
  readonly jobId: string;
  readonly leaseEpoch: number;

  constructor(deps: ThreadRunDeps, jobId: string, leaseEpoch: number) {
    this.deps = deps;
    this.jobId = jobId;
    this.leaseEpoch = leaseEpoch;
    this.events = new JobEvents(this.deps.journal, this.jobId, this.leaseEpoch, this.deps.log);
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

    if (thread.action === 'PUBLISH' || thread.action === 'DISCARD') {
      this.events.transition('RUNNING', undefined, { pid: null, pgid: null, branch: null });
      await this.openStream(thread, false, false, false);
      if (this.halted) { this.releaseEnd(); return; }
      const writer = this.writer;
      if (writer === null) throw new Error('thread action stream was not opened');
      await runThreadAction({
        deps: this.deps, row, thread, writer,
        transition: (to, reason) => this.events.transition(to, reason), halted: () => this.halted,
      });
      this.releaseEnd();
      return;
    }

    if (thread.kind === 'PROJECT') {
      await this.runProject(row, thread);
      return;
    }

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
      tools: [
        ...buildThreadTools({
          worktree: prepared.worktree,
          skillsRoot: this.skillsRoot(),
          skills: thread.skills,
          git: this.deps.host.git,
          searchTimeoutMs: this.deps.tuning.threadSearchTimeoutMs,
          nowMs: () => this.deps.now().getTime(),
          feature: thread.feature,
          onDocWritten: (path, bytes) => { if (!this.halted) this.writer?.docWritten(path, bytes); },
        }),
        ...this.kodaToolProxies(thread),
      ],
      approvalTimeoutSec: row.assign.approvalTimeoutSec,
    });
    if (this.halted) {
      // There is no close of the run's own to await: the session `open` resolved is closed then, unawaited, so a
      // hung `close()` cannot block `start` — the `abandon` that halted this run has already returned.
      if (opened.ok) this.startSessionClose(opened.session);
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

    // Steps 7-8: the row goes RUNNING, the stream is created and announced, the heartbeat starts and the first
    // turn (or, with no initial message, the idle timer) begins.
    this.session = opened.session;
    this.maxCostUsd = Number(row.assign.maxCostUsd);
    this.events.transition('RUNNING', undefined, { pid: null, pgid: null, branch: null });
    await this.openStream(thread, opened.resumed, prepared.stale === true);
    this.livePublish = new ThreadLivePublish({
      publish: this.deps.host.publish ?? publishThreadDocs,
      input: { git: this.deps.host.git, mutex: publishInputMutex(this.deps.mutex), repoKey: row.repoKey, worktree: prepared.worktree,
        feature: thread.feature, threadId: thread.threadId, title: thread.title ?? thread.feature, identity: row.assign.gitIdentity },
      writer: () => this.writer,
      turnRunning: () => this.turnRunning,
      stopped: () => this.halted,
      stopIdle: () => this.stopIdle(),
      armIdle: () => this.armIdle(),
    });
    this.startHeartbeat();
    this.startInitialTurn(thread);
    await this.waitForEnd();
  }

  /**
   * A PROJECT thread has no checkout: no git credentials and no worktree (steps 1-4 are skipped). The session runs in
   * an empty scratch directory under the thread's own directory, with the skill tools only, and the run has no live publish.
   */
  private async runProject(row: JobRow, thread: ThreadAssign): Promise<void> {
    const skills = await this.setUpSkills(thread);
    if (this.stopped()) return;
    if (!skills.ok) {
      this.endBeforeRunning('FAILED', skills.reason);
      return;
    }
    const scratch = threadScratchDir(this.deps.host.homeDir, thread.threadId);
    await mkdir(scratch, { recursive: true, mode: 0o700 });
    const opened = await this.deps.host.sessions.open({
      jobId: this.jobId,
      thread,
      worktree: scratch,
      tools: [
        ...buildProjectThreadTools({
          worktree: scratch,
          skillsRoot: this.skillsRoot(),
          skills: thread.skills,
          git: this.deps.host.git,
          searchTimeoutMs: this.deps.tuning.threadSearchTimeoutMs,
          nowMs: () => this.deps.now().getTime(),
        }),
        ...this.kodaToolProxies(thread),
      ],
      approvalTimeoutSec: row.assign.approvalTimeoutSec,
    });
    if (this.halted) {
      if (opened.ok) this.startSessionClose(opened.session);
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
    this.session = opened.session;
    this.maxCostUsd = Number(row.assign.maxCostUsd);
    this.events.transition('RUNNING', undefined, { pid: null, pgid: null, branch: null });
    await this.openStream(thread, opened.resumed, false);
    this.startHeartbeat();
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

  /**
   * Fleet S5b US-006: the ASSIGN's koda tool proxies, appended after the kind's own tools in descriptor order.
   * The API defines and executes the tools; this run only forwards each call with the provider's tool call id.
   * Without descriptors, or without a host caller (a runner that was never wired to one), the kind's tools stand
   * alone — a session whose runner cannot proxy koda tools reaches no koda data.
   */
  private kodaToolProxies(thread: ThreadAssign): EmbedderTool[] {
    const descriptors = thread.kodaTools;
    const caller = this.deps.host.kodaTools;
    if (descriptors === undefined || caller === undefined) return [];
    return buildKodaToolProxies(descriptors, { jobId: this.jobId, leaseEpoch: this.leaseEpoch, caller });
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

  /** A session the run no longer needs is closed, bounded by `threadCloseTimeoutMs`; a throwing `close` is logged, never fatal. */
  private async closeSession(session: AgentSession): Promise<void> {
    this.startSessionClose(session);
    await this.awaitSessionClose();
  }

  /** The session does not outlive the run: it is closed through the same bounded path as every other exit. */
  private async closeHeldSession(): Promise<void> {
    const session = this.session;
    this.session = null;
    if (session !== null) await this.closeSession(session);
  }

  /**
   * Step 7: the stream file is recreated — it is keyed by job id only, so a requeued epoch must never re-ship
   * the lines of the epoch it replaces — then registered with the shipper and announced to the server.
   */
  private async openStream(thread: ThreadAssign, resumed: boolean, stale: boolean, announce = true): Promise<void> {
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
      onCap: () => this.requestClose('stream_cap'),
      onWarn: (message) => this.events.lifecycle('warn', message),
    });
    this.writer = writer;
    this.deps.logs.register({
      jobId: this.jobId,
      leaseEpoch: this.leaseEpoch,
      threadPath,
      lifecycle: (level, message) => this.events.lifecycle(level, message),
    });
    if (announce) writer.started({ resumed, backend: thread.backend, skillShas: thread.skills.map((source) => source.sha), stale });
  }

  /** Step 8: the initial message's turn, off the `start` path; with no initial message the run only idles. */
  private startInitialTurn(thread: ThreadAssign): void {
    const message = thread.initialMessage;
    if (message === null) {
      this.armIdle();
      return;
    }
    void this.runTurn(message.messageId, message.text);
  }

  /**
   * One turn: the flag goes up and the idle timer stops before anything is written, every session event reaches
   * the writer, and the flag comes down only once the iteration has ended. An iteration that throws while the run
   * is neither closing nor halted is the run's own failure. After a halt the turn is abandoned where it stands:
   * its tail writes no stream line, no journal event and no transition.
   */
  private async runTurn(messageId: string, text: string): Promise<void> {
    const session = this.session;
    const writer = this.writer;
    if (session === null || writer === null) return;
    this.turnRunning = true;
    this.stopIdle();
    this.turnSettled = new Promise<void>((resolve) => { this.turnDone = resolve; });
    let failure: unknown = null;
    try {
      writer.inputConsumed(messageId);
      // Session adapters may return the stream directly or resolve it asynchronously; await handles both forms.
      // A resolved void means the adapter has no more events for this turn, not a failed session.
      const stream = await session.send(text);
      if (stream !== undefined && stream !== null) for await (const event of stream) {
        if (this.halted) break;
        this.consume(event, writer);
      }
      if (!this.halted) writer.flush();
    } catch (error) {
      failure = error;
    } finally {
      this.releaseTurn();
    }
    if (this.halted) return;
    if (failure !== null) {
      if (!this.closing) await this.failSession();
      return;
    }
    this.armIdle();
  }

  /**
   * Every event of a turn is streamed; the cost of a `usage` event is added to the job's spend and may close it.
   * The writer drops a malformed chunk (a null or non-object event) with a warning, and the cost read must not
   * take the job down in its place.
   */
  private consume(event: SessionEvent, writer: ThreadEventWriter): void {
    writer.event(event);
    if (typeof event !== 'object' || event === null || event.type !== 'usage') return;
    // External nax-agent data: a cost that is not a finite, non-negative number is not a cost. A NaN would disable
    // the cap for the rest of the job and a negative value would un-count spend.
    const costUsd: unknown = event.costUsd;
    if (typeof costUsd !== 'number' || !Number.isFinite(costUsd) || costUsd < 0) return;
    this.spent += costUsd;
    if (this.spent >= this.maxCostUsd) this.requestClose('cost_cap');
  }

  private releaseTurn(): void {
    this.turnRunning = false;
    const done = this.turnDone;
    this.turnDone = null;
    done?.();
  }

  /** The idle timer runs only while no turn does; its expiry closes the run. */
  private armIdle(): void {
    this.stopIdle();
    if (this.halted || this.closing) return;
    const abort = new AbortController();
    this.idleAbort = abort;
    const dueAtMs = this.deps.now().getTime() + this.deps.tuning.threadIdleMs;
    void this.deps.sleep(this.deps.tuning.threadIdleMs, abort.signal).then(() => {
      // A sleeper that returns before the injected clock reaches the deadline cannot pace the timer: it neither
      // expires now nor re-arms, because either would busy-loop instead of waiting out `threadIdleMs`.
      if (abort.signal.aborted || this.deps.now().getTime() < dueAtMs) return;
      this.requestClose('idle');
    }, (error: unknown) => this.deps.log.warn('thread idle wait failed', { jobId: this.jobId, error: errorMessage(error) }));
  }

  private stopIdle(): void {
    this.idleAbort?.abort();
    this.idleAbort = null;
  }

  /** A RUNNING run stamps `heartbeatAt` every `threadHeartbeatMs`, until the close stops it. */
  private startHeartbeat(): void {
    this.stopHeartbeat();
    const abort = new AbortController();
    this.heartbeatAbort = abort;
    void this.heartbeat(abort.signal);
  }

  private async heartbeat(signal: AbortSignal): Promise<void> {
    for (;;) {
      const dueAtMs = this.deps.now().getTime() + this.deps.tuning.threadHeartbeatMs;
      try {
        await this.deps.sleep(this.deps.tuning.threadHeartbeatMs, signal);
      } catch (error) {
        this.deps.log.warn('thread heartbeat wait failed', { jobId: this.jobId, error: errorMessage(error) });
        return;
      }
      // Same rule as the idle timer: a wait that returns before the clock reaches its deadline cannot pace the
      // heartbeat, and re-arming it would spin.
      if (signal.aborted || this.deps.now().getTime() < dueAtMs) return;
      if (this.halted) return;
      try {
        this.events.snapshot({ heartbeatAt: this.deps.now().toISOString() });
      } catch (error) {
        // A journal that refuses one snapshot (a closed or failing database) must not reach this void-fired loop
        // as an unhandled rejection, and must not kill the liveness signal: the next interval tries again.
        this.deps.log.warn('thread heartbeat snapshot failed', { jobId: this.jobId, error: errorMessage(error) });
      }
    }
  }

  private stopHeartbeat(): void {
    this.heartbeatAbort?.abort();
    this.heartbeatAbort = null;
  }

  /** B3b-R3: the first close reason wins, and the turn check is made before the close's first await. */
  private requestClose(reason: ThreadCloseReason): void {
    if (this.closing || this.halted) return;
    this.closing = true;
    void this.finishRun(reason, false);
  }

  private async failSession(): Promise<void> {
    if (this.closing) return;
    this.closing = true;
    await this.finishRun(SESSION_ERROR, true);
  }

  /**
   * The one close and the one fail: the idle timer stops, a running turn is cancelled and waited out, the session
   * is closed, the stream is sealed, the logs drain under the transition, the heartbeat stops, and the row ends
   * `UPLOADING` → the terminal state. `failed` seals the stream with `session_failed` and ends `FAILED`.
   */
  private async finishRun(reason: ThreadCloseReason | typeof SESSION_ERROR, failed: boolean): Promise<void> {
    try {
      this.stopIdle();
      // A halt that lands before the close does: the row is left as it stands and nothing more is written.
      if (this.halted) return;
      await this.livePublish?.wait();
      if (this.halted) return;
      if (this.turnRunning) {
        // A cancel that throws must not abandon the close: the stream still gets sealed and the row still ends.
        try {
          this.session?.cancel(reason);
        } catch (error) {
          this.deps.log.warn('thread session cancel failed', { jobId: this.jobId, error: errorMessage(error) });
        }
        await this.turnSettled;
      }
      await this.closeHeldSession();
      // A halt that landed while the turn settled or the session closed: nothing after this writes a stream line.
      if (this.halted) return;
      const writer = this.writer;
      if (writer !== null) {
        writer.flush();
        if (failed) writer.failed(reason);
        else writer.closed(reason);
      }
      await this.awaitLogs(this.deps.logs.drain(this.jobId, this.leaseEpoch, this.deps.tuning.logDrainTimeoutMs));
      this.stopHeartbeat();
      if (this.halted) return;
      this.events.transition('UPLOADING');
      if (failed) this.events.transition('FAILED', reason);
      else this.events.transition(reason === 'cancelled' ? 'CANCELLED' : 'COMPLETED', reason);
      this.deps.logs.stopJob(this.jobId, this.leaseEpoch);
      this.deps.journal.markDone(this.jobId, this.leaseEpoch);
    } catch (error) {
      this.deps.log.error('thread run could not be finished', { jobId: this.jobId, error: errorMessage(error) });
    } finally {
      this.releaseEnd();
    }
  }

  /** A drain that times out is reported; the bundle the API builds carries the rest of the stream. */
  private async awaitLogs(drained: Promise<DrainResult>): Promise<void> {
    if ((await drained) !== 'timeout') return;
    const seconds = Math.max(1, Math.round(this.deps.tuning.logDrainTimeoutMs / 1000));
    this.events.lifecycle('warn', `log upload did not finish within ${seconds} s; the bundle fills the rest`);
  }

  /** The promise `start` resolves on covers the whole run: it resolves on a halt, an abandon or a terminal end. */
  private async waitForEnd(): Promise<void> {
    if (this.halted || this.ended) return;
    await new Promise<void>((resolve) => this.endWaiters.push(resolve));
  }

  private releaseEnd(): void {
    this.ended = true;
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
      this.stopIdle();
      this.stopHeartbeat();
      if (this.events.currentState() === 'RUNNING') {
        this.events.lifecycle('error', `runner error: ${errorMessage(error)}`);
        this.events.transition('UPLOADING');
        this.events.transition('FAILED', SESSION_ERROR);
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

  /**
   * B3b-R2: a thread command is applied synchronously — `CommandHandler.handle` is awaited inline by the sync loop,
   * so a command never waits on a turn, a close or a drain. A `THREAD_INPUT` that returns `ok` has already claimed
   * the turn slot, so a second one in the same batch sees `turn_running` (B3-R5, no input queue).
   */
  command(type: 'THREAD_INPUT' | 'THREAD_STOP_TURN' | 'THREAD_CLOSE' | 'THREAD_PUBLISH', payload: unknown): ThreadCommandOutcome;
  command(type: ThreadCommandType, payload: unknown): ThreadCommandOutcome | Promise<ThreadCommandOutcome>;
  command(type: ThreadCommandType, payload: unknown): ThreadCommandOutcome | Promise<ThreadCommandOutcome> {
    if (this.closing || this.halted) return { result: 'rejected', detail: 'session_closed' };
    const action = this.row()?.assign.thread?.action;
    if (action === 'PUBLISH' || action === 'DISCARD') return { result: 'rejected', detail: 'no_session' };
    // A command only applies once the run can actually keep it: the row goes RUNNING before `openStream` awaits
    // its way to the writer, and in that window a turn could not be streamed — so the run is not ready yet.
    if (this.events.currentState() !== 'RUNNING' || this.writer === null) return { result: 'rejected', detail: 'session_not_ready' };
    if (type === 'THREAD_PUBLISH' && this.row()?.assign.thread?.kind === 'PROJECT') return { result: 'rejected', detail: 'not_repo_thread' };
    if (type === 'THREAD_PUBLISH') return this.livePublish?.command() ?? { result: 'rejected', detail: 'session_not_ready' };
    switch (type) {
      case 'THREAD_INPUT': return this.applyInput(payload);
      case 'THREAD_ANSWER': return this.applyAnswer(payload);
      case 'THREAD_STOP_TURN': return this.applyStopTurn();
      case 'THREAD_CLOSE': return this.applyClose();
      default: return { result: 'rejected', detail: 'unsupported' };
    }
  }

  /** The turn starts in the background; the ack does not wait for it. */
  private applyInput(payload: unknown): ThreadCommandOutcome {
    const message = readInput(payload);
    if (message === null) return { result: 'rejected', detail: 'invalid payload' };
    if (this.livePublish?.publishing) return { result: 'rejected', detail: 'publishing' };
    if (this.turnRunning) return { result: 'rejected', detail: 'turn_running' };
    void this.runTurn(message.messageId, message.text);
    return { result: 'ok' };
  }

  /** nax-agent decides whether the ask is still answerable; its status is the ack's detail when it is not. */
  private applyAnswer(payload: unknown): ThreadCommandOutcome | Promise<ThreadCommandOutcome> {
    const answer = readAnswer(payload);
    if (answer === null) return { result: 'rejected', detail: 'invalid payload' };
    const session = this.session;
    if (session === null) return { result: 'rejected', detail: 'session_not_ready' };
    try {
      const status: unknown = session.answer(answer.requestId, { text: answer.text });
      if (status instanceof Promise) {
        return status.then((value: string) => value === 'accepted' ? { result: 'ok' as const } : { result: 'rejected' as const, detail: String(value) })
          .catch((error: unknown) => {
            this.deps.log.warn('thread session answer failed', { jobId: this.jobId, error: errorMessage(error) });
            return { result: 'rejected' as const, detail: 'unknown' };
          });
      }
      return status === 'accepted' ? { result: 'ok' } : { result: 'rejected', detail: String(status) };
    } catch (error) {
      // A throwing answer must not escape `command`: the sync loop awaits `CommandHandler.handle` inline. nax-agent
      // throws `AGENT_SESSION_INVALID_ANSWER` for a request id it never issued, so the ask is gone either way — the
      // same `unknown` its non-throwing path answers for a request that is no longer pending.
      this.deps.log.warn('thread session answer failed', { jobId: this.jobId, error: errorMessage(error) });
      return { result: 'rejected', detail: 'unknown' };
    }
  }

  /** `THREAD_STOP_TURN` stops the turn, never the session: the row stays RUNNING and may run another turn. */
  private applyStopTurn(): ThreadCommandOutcome {
    if (this.turnRunning) {
      // A cancel that throws must not escape `command`: the sync loop awaits `CommandHandler.handle` inline.
      try {
        this.session?.cancel('stopped');
      } catch (error) {
        this.deps.log.warn('thread session cancel failed', { jobId: this.jobId, error: errorMessage(error) });
      }
    }
    return { result: 'ok' };
  }

  /** B3b-R2: the close runs in the background; the ack does not wait for it. */
  private applyClose(): ThreadCommandOutcome {
    this.requestClose('closed');
    return { result: 'ok' };
  }

  /**
   * B3b-R3: before RUNNING the request only records `cancelRequestedAt` — the next start step ends CANCELLED; while
   * RUNNING it closes the run with `cancelled`; while it is already closing it changes nothing. Only a terminal row
   * answers false.
   */
  requestCancel(): boolean {
    const row = this.row();
    if (row === null || isTerminalState(row.state)) return false;
    if (row.cancelRequestedAt === null) {
      this.deps.journal.updateJob(this.jobId, this.leaseEpoch, { cancelRequestedAt: this.deps.now().toISOString() });
    }
    const action = row.assign.thread?.action;
    if (this.events.currentState() === 'RUNNING' && action !== 'PUBLISH' && action !== 'DISCARD') this.requestClose('cancelled');
    return true;
  }

  /**
   * Daemon stop: the run's background tasks stop writing, the session is closed without waiting, and `start`
   * resolves without waiting for the turn. The close promise is kept so each later wait on it is bounded.
   */
  halt(): void {
    this.halted = true;
    this.stopIdle();
    this.stopHeartbeat();
    if (this.turnRunning) {
      try {
        this.session?.cancel('halted');
      } catch (error) {
        this.deps.log.warn('thread session cancel failed', { jobId: this.jobId, error: errorMessage(error) });
      }
    }
    const session = this.session;
    this.session = null;
    if (session !== null) this.startSessionClose(session);
    this.deps.logs.stopJob(this.jobId, this.leaseEpoch);
    this.releaseEnd();
  }

  /** `session.close()` is called once per run; a throw is logged and the stored promise still resolves. */
  private startSessionClose(session: AgentSession): void {
    if (this.sessionClose !== null) return;
    this.sessionClose = session.close().catch((error: unknown) => {
      this.deps.log.warn('thread session close failed', { jobId: this.jobId, error: errorMessage(error) });
    });
  }

  /**
   * B3b-R1: no mutex, and the only wait is the session close — never longer than `threadCloseTimeoutMs`. A refused release is logged and never held against a row that is already gone.
   */
  async abandon(): Promise<void> {
    this.halt();
    const row = this.row();
    this.deps.journal.abandon(this.jobId, this.leaseEpoch);
    if (row !== null) {
      try {
        await this.deps.host.credentials.release(row);
      } catch (error) {
        this.deps.log.warn('credential release failed', { jobId: this.jobId, error: errorMessage(error) });
      }
    }
    await this.awaitSessionClose();
  }

  /**
   * Waits for the stored session close, for at most `threadCloseTimeoutMs`; a timeout is reported and never fatal.
   * With `open` still pending there is no close to await — the session `open` resolves is closed then, unawaited.
   */
  private async awaitSessionClose(): Promise<void> {
    const close = this.sessionClose;
    if (close === null) return;
    const abort = new AbortController();
    const timedOut = this.deps.sleep(this.deps.tuning.threadCloseTimeoutMs, abort.signal).then(() => true);
    try {
      if (await Promise.race([close.then(() => false), timedOut])) {
        this.deps.log.warn('thread session close timed out', { jobId: this.jobId, leaseEpoch: this.leaseEpoch });
      }
    } finally {
      abort.abort();
    }
  }
}
