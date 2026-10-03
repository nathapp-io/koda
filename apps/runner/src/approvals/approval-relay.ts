import { randomBytes } from 'node:crypto';
import type { ApprovalAnswerPayload, FleetCommandOut } from '@nathapp/fleet-protocol';
import { errorMessage } from '../errors';
import type { Journal } from '../journal/journal';
import type { JobRow } from '../journal/types';
import type { Logger } from '../logger';
import { JobEvents } from '../supervisor/job-events';
import type { Now } from '../time';
import { ApprovalReceiver } from './approval-receiver';
import { buildAskPayload, type NaxAskRequest } from './ask-payload';
import { callbackUrlFor, postToNax, type NaxAnswer } from './nax-callback';

export interface RelayEndpoint { url: string; secret: string }
export interface ApprovalRelayDeps {
  readonly journal: Journal;
  readonly log: Logger;
  readonly now: Now;
  readonly randomSecret?: () => string;
}
type Outcome = { result: 'ok' | 'rejected'; detail?: string };

const CHOICES: readonly string[] = ['allow', 'allow-remember', 'deny'];
const SIZE_GATE = /^ix-.+-size-gate$/;
const PAUSED_RESUME = /^ix-.+-paused-resume$/;
const key = (jobId: string, leaseEpoch: number): string => `${jobId}:${leaseEpoch}`;
const urlOf = (port: number): string => `http://127.0.0.1:${port}/ask`;

/**
 * Plan D277: a headless nax run never prompts (null chain). With the relay's chain present, two prompts that are not
 * trigger-guarded would fire; answer them as headless behaves: a size-flagged story runs, a paused story stays paused.
 */
function headlessAnswer(id: string): Pick<NaxAnswer, 'action' | 'value'> & { known: boolean } {
  if (SIZE_GATE.test(id)) return { action: 'approve', known: true };
  if (PAUSED_RESUME.test(id)) return { action: 'choose', value: 'keep', known: true };
  return { action: 'skip', known: false };
}

/** Spec §4: one loopback receiver per non-raw (job, epoch); asks go up as events, answers come down as commands. */
export class ApprovalRelay {
  private readonly receivers = new Map<string, ApprovalReceiver>();

  constructor(private readonly deps: ApprovalRelayDeps) {}

  /** Spec §4.1: fresh 32-byte secret, free port. Re-prepare: same endpoint, or a fresh one if its port was taken (D286). */
  async open(job: JobRow): Promise<RelayEndpoint> {
    const k = key(job.jobId, job.leaseEpoch);
    const stored = this.deps.journal.getApprovalReceiver(job.jobId, job.leaseEpoch);
    if (stored) {
      if (this.receivers.has(k)) return { url: urlOf(stored.port), secret: stored.secret };
      try {
        this.bind(job, stored.port, stored.secret);
        return { url: urlOf(stored.port), secret: stored.secret };
      } catch {
        // nax was not spawned yet (this is prepare), so nothing holds the old address: take a new one.
      }
    }
    const secret = (this.deps.randomSecret ?? (() => randomBytes(32).toString('hex')))();
    const receiver = this.bind(job, 0, secret);
    this.deps.journal.putApprovalReceiver({ jobId: job.jobId, leaseEpoch: job.leaseEpoch, port: receiver.port, secret });
    return { url: urlOf(receiver.port), secret };
  }

  /** Spec §4.5 / plan D273: READOPT re-binds the journalled port and secret (a live nax holds them). Throws when taken. */
  async resume(job: JobRow): Promise<void> {
    const stored = this.deps.journal.getApprovalReceiver(job.jobId, job.leaseEpoch);
    if (!stored || this.receivers.has(key(job.jobId, job.leaseEpoch))) return;
    this.bind(job, stored.port, stored.secret);
  }

  /** Plan D285: one epoch only. */
  async close(jobId: string, leaseEpoch: number): Promise<void> {
    const k = key(jobId, leaseEpoch);
    this.receivers.get(k)?.stop();
    this.receivers.delete(k);
    this.deps.journal.deleteApprovalState(jobId, leaseEpoch);
  }

  /** Daemon start: a crash can leave state of (job, epoch) pairs that have since ended. */
  sweepOrphans(active: readonly JobRow[]): void {
    const live = new Set(active.map((j) => key(j.jobId, j.leaseEpoch)));
    for (const s of this.deps.journal.approvalStateKeys()) if (!live.has(key(s.jobId, s.leaseEpoch))) this.deps.journal.deleteApprovalState(s.jobId, s.leaseEpoch);
  }

  /** Daemon stop or crash: stop listening; the journal keeps the state for the next boot's READOPT. */
  stopAll(): void {
    for (const receiver of this.receivers.values()) receiver.stop();
    this.receivers.clear();
  }

  /** Spec §4.4: APPROVAL_ANSWER -> one signed POST to nax's callback. Never throws (a throw would re-run it). */
  async answer(command: FleetCommandOut): Promise<Outcome> {
    const p = command.payload as Partial<ApprovalAnswerPayload>;
    if (typeof p.naxAskId !== 'string' || typeof p.choice !== 'string' || !CHOICES.includes(p.choice)) return { result: 'rejected', detail: 'invalid payload' };
    const { journal } = this.deps;
    const ask = journal.getPendingAsk(command.jobId, command.leaseEpoch, p.naxAskId);
    if (!ask) return { result: 'rejected', detail: 'ask_not_pending' };
    const row = journal.getJob(command.jobId, command.leaseEpoch);
    if (!row || row.doneAt !== null || row.state !== 'RUNNING') return { result: 'rejected', detail: 'job_not_running' };
    const receiver = journal.getApprovalReceiver(command.jobId, command.leaseEpoch);
    if (!receiver) return { result: 'rejected', detail: 'job_not_running' };
    const posted = await postToNax(ask.callbackUrl, receiver.secret, {
      requestId: p.naxAskId, action: 'choose', value: p.choice, respondedBy: 'koda', respondedAt: Date.now(),
    });
    if (!posted.ok) return { result: 'rejected', detail: posted.detail };
    journal.deletePendingAsk(command.jobId, command.leaseEpoch, p.naxAskId);
    return { result: 'ok' };
  }

  private bind(job: JobRow, port: number, secret: string): ApprovalReceiver {
    const receiver = ApprovalReceiver.start({ port, secret, onRequest: (body) => this.onRequest(job, secret, body) });
    this.receivers.set(key(job.jobId, job.leaseEpoch), receiver);
    return receiver;
  }

  /** Spec §4.2: answer nax at once; the human's answer arrives later through `answer`. */
  private async onRequest(job: JobRow, secret: string, body: unknown): Promise<number> {
    const events = new JobEvents(this.deps.journal, job.jobId, job.leaseEpoch, this.deps.log);
    const request = (body ?? {}) as NaxAskRequest;
    const callbackUrl = callbackUrlFor(request);
    if (!callbackUrl) {
      events.lifecycle('warn', 'nax interaction refused: unexpected callback address');
      return 400;
    }
    if (request.metadata?.['approvalPrompt'] !== true) {
      const reply = headlessAnswer(request.id);
      events.lifecycle(reply.known ? 'info' : 'warn', `nax prompt ${request.id} answered ${reply.value ?? reply.action} (headless behaviour, plan D277)`);
      const { known: _known, ...answer } = reply;
      void postToNax(callbackUrl, secret, { requestId: request.id, ...answer, respondedBy: 'koda', respondedAt: Date.now() })
        .then((posted) => { if (!posted.ok) this.deps.log.warn('nax prompt answer failed', { jobId: job.jobId, detail: posted.detail }); })
        .catch((error: unknown) => this.deps.log.warn('nax prompt answer failed', { jobId: job.jobId, error: errorMessage(error) }));
      return 200;
    }
    const payload = buildAskPayload(request);
    if (!payload) {
      events.lifecycle('warn', 'nax approval ask refused: not a relayable ask');
      return 400;
    }
    this.deps.journal.tx(() => {
      const fresh = this.deps.journal.insertPendingAsk({ jobId: job.jobId, leaseEpoch: job.leaseEpoch, naxAskId: payload.naxAskId, callbackUrl, deadlineAt: payload.deadlineAt });
      if (fresh) events.approvalRequest(payload);   // plan D286: a re-sent nax POST appends nothing
    });
    return 200;
  }
}
