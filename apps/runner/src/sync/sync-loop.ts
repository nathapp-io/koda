import type { CommandAck, FleetCommandOut, RunnerCapabilities, SyncRequest, SyncResponse } from '@nathapp/fleet-protocol';
import { errorMessage } from '../errors';
import type { Journal } from '../journal/journal';
import type { Logger } from '../logger';
import type { Sleep } from '../time';
import { backoffDelay } from './backoff';
import { FULL_SCALE, buildSyncRequest, clampAck, doubleScale, halveScale, type BatchScale } from './batch';
import { ServerError } from './http';

/** MEM-1: a server-side filter or a stale identity can hold an ack forever; the map never grows without bound. */
export const PENDING_ACK_TTL_MS = 60 * 60 * 1000;

export interface StopReason {
  readonly kind: 'protocol' | 'auth';
  readonly message: string;
}

export type SyncOutcome =
  | { kind: 'ok' }
  | { kind: 'woken' }
  | { kind: 'again' }
  | { kind: 'retry'; delayMs: number }
  | { kind: 'stop'; reason: StopReason };

export interface CapabilityReport {
  readonly capabilities: RunnerCapabilities;
  readonly hash: string;
}

export interface SyncLoopDeps {
  readonly client: { sync(request: SyncRequest, signal?: AbortSignal): Promise<SyncResponse> };
  readonly journal: Pick<Journal, 'jobsWithPending' | 'pendingEvents' | 'ackThrough' | 'replaceEvent' | 'onWrite'>;
  readonly bootId: string;
  readonly daemonVersion: string;
  readonly freeSlots: () => number;
  readonly capabilityReport: () => CapabilityReport | null;
  readonly onCapabilitiesSent: (hash: string) => void;
  readonly handleCommands: (commands: readonly FleetCommandOut[]) => Promise<CommandAck[]>;
  readonly abandonUnknown: (jobIds: readonly string[]) => Promise<void>;
  readonly onStop: (reason: StopReason) => void;
  readonly log: Logger;
  readonly sleep: Sleep;
  readonly random: () => number;
  readonly nowMs: () => number;
  readonly minGapMs: number;
}

export class SyncLoop {
  private stopped = false;
  private scale: BatchScale = FULL_SCALE;
  private failures = 0;
  private capsRejected: string | null = null;
  private inflight: AbortController | null = null;
  private inflightIdle = false;
  private dirty = false;
  private acksExcluded = false;
  private readonly pendingAcks = new Map<string, CommandAck>();
  private readonly pendingAcksAt = new Map<string, number>();
  private readonly unsubscribe: () => void;

  constructor(private readonly deps: SyncLoopDeps) {
    this.unsubscribe = deps.journal.onWrite(() => this.wake());
  }

  /**
   * Only an idle poll (nothing to deliver) is aborted: a request that carries events or acks may already be applied
   * by the server, and dropping its response would re-deliver commands. Otherwise the next sync just starts at once.
   */
  wake(): void {
    this.pruneStalePendingAcks(this.deps.nowMs());
    if (!this.inflight) return;
    if (this.inflightIdle) this.inflight.abort('wake');
    else this.dirty = true;
  }

  /** MEM-1: drop pending acks that have been queued longer than `maxAgeMs` (default `PENDING_ACK_TTL_MS`). */
  pruneStalePendingAcks(nowMs: number, maxAgeMs: number = PENDING_ACK_TTL_MS): number {
    let pruned = 0;
    for (const [id, appliedAt] of [...this.pendingAcksAt]) {
      if (nowMs - appliedAt >= maxAgeMs) {
        this.pendingAcks.delete(id);
        this.pendingAcksAt.delete(id);
        pruned += 1;
      }
    }
    return pruned;
  }

  stop(): void {
    this.stopped = true;
    this.unsubscribe();
    this.inflight?.abort('stop');
  }

  async run(): Promise<void> {
    while (!this.stopped) {
      const started = this.deps.nowMs();
      const outcome = await this.syncOnce();
      if (outcome.kind === 'stop') {
        this.stopped = true;
        this.unsubscribe();
        this.deps.onStop(outcome.reason);
        return;
      }
      if (outcome.kind === 'retry') await this.deps.sleep(outcome.delayMs);
      else if (outcome.kind !== 'again' && !this.dirty) await this.deps.sleep(Math.max(0, this.deps.minGapMs - (this.deps.nowMs() - started)));
    }
  }

  private report(): CapabilityReport | null {
    const report = this.deps.capabilityReport();
    return report && report.hash !== this.capsRejected ? report : null;
  }

  async syncOnce(): Promise<SyncOutcome> {
    const report = this.report();
    this.dirty = false; // anything written from here on is either in this request or marks the next one
    const request = buildSyncRequest({
      journal: this.deps.journal, bootId: this.deps.bootId, daemonVersion: this.deps.daemonVersion, freeSlots: this.deps.freeSlots(),
      acks: this.acksExcluded ? [] : [...this.pendingAcks.values()], capabilities: report?.capabilities, scale: this.scale,
    });
    const controller = new AbortController();
    this.inflightIdle = request.jobs.length === 0 && request.commandAcks.length === 0 && request.tokenRequests.length === 0;
    this.inflight = controller;
    try {
      const response = await this.deps.client.sync(request, controller.signal);
      return await this.apply(request, response, report);
    } catch (error) {
      return this.classify(error, request, controller, report);
    } finally {
      this.inflight = null;
    }
  }

  private async apply(request: SyncRequest, response: SyncResponse, report: CapabilityReport | null): Promise<SyncOutcome> {
    this.inflightIdle = false; // writes made while commands are handled below must not be aborted, only marked dirty
    for (const ack of response.jobAcks ?? []) {
      const reported = request.jobs.find((job) => job.jobId === ack.jobId);
      if (reported) this.deps.journal.ackThrough(ack.jobId, reported.leaseEpoch, ack.ackedSeq);
    }
    for (const ack of request.commandAcks) {
      this.pendingAcks.delete(ack.commandId);
      this.pendingAcksAt.delete(ack.commandId);   // MEM-1: don't leave a timestamp for a confirmed ack
    }
    if (this.acksExcluded) this.stripPendingAckDetails();
    if (report && request.capabilities) this.deps.onCapabilitiesSent(report.hash);
    this.failures = 0;
    this.scale = doubleScale(this.scale);
    const unknown = response.unknownJobIds ?? [];
    if (unknown.length > 0) await this.deps.abandonUnknown(unknown);
    const commands = response.commands ?? [];
    if (commands.length > 0) {
      const stamp = this.deps.nowMs();
      for (const ack of await this.deps.handleCommands(commands)) {
        this.pendingAcks.set(ack.commandId, clampAck(ack));
        this.pendingAcksAt.set(ack.commandId, stamp);
      }
    }
    return { kind: 'ok' };
  }

  private classify(error: unknown, request: SyncRequest, controller: AbortController, report: CapabilityReport | null): SyncOutcome {
    if (controller.signal.aborted) return { kind: 'woken' };
    if (error instanceof ServerError) {
      if (error.status === 426) return { kind: 'stop', reason: { kind: 'protocol', message: error.message } };
      if (error.status === 401) return { kind: 'stop', reason: { kind: 'auth', message: error.message } };
      if (error.status === 400 || error.status === 413) return this.badBatch(request, report, error);
    }
    return this.retry(error);
  }

  private badBatch(request: SyncRequest, report: CapabilityReport | null, error: ServerError): SyncOutcome {
    if (report && request.capabilities && error.status === 400) {
      this.capsRejected = report.hash;
      this.deps.log.error('server rejected the capabilities report; fix runner.json capabilities', { status: error.status });
      return { kind: 'again' };
    }
    const next = halveScale(this.scale);
    if (next) {
      this.scale = next;
      return { kind: 'again' };
    }
    if (error.status === 400 && request.commandAcks.length > 0) {
      // D58: the acks may be the poison, not the event; try once without them before blaming an event.
      this.acksExcluded = true;
      this.deps.log.warn('sync rejected at the smallest batch; retrying once without command acks');
      return { kind: 'again' };
    }
    const job = request.jobs[0];
    const event = job?.events[0];
    if (!job || !event) return this.retry(error);
    const message = `event ${event.seq} (${event.type}) dropped: the server rejected it (${error.status})`;
    this.deps.journal.replaceEvent(job.jobId, job.leaseEpoch, event.seq, 'lifecycle', { level: 'error', message });
    this.deps.log.error(message, { jobId: job.jobId });
    this.scale = FULL_SCALE;
    return { kind: 'again' };
  }

  /** The acks-free retry worked, so the acks were the problem: resend them without their free-text detail (D58). */
  private stripPendingAckDetails(): void {
    this.acksExcluded = false;
    this.deps.log.warn('sync succeeded once command acks were left out; resending them without detail', { acks: this.pendingAcks.size });
    for (const [id, ack] of [...this.pendingAcks]) this.pendingAcks.set(id, { commandId: ack.commandId, leaseEpoch: ack.leaseEpoch, result: ack.result });
  }

  private retry(error: unknown): SyncOutcome {
    const delayMs = backoffDelay(this.failures, this.deps.random);
    this.failures += 1;
    this.deps.log.warn('sync failed; backing off', { error: errorMessage(error), delayMs });
    return { kind: 'retry', delayMs };
  }
}
