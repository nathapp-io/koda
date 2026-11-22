import type { CommandAck, FleetCommandOut, GitToken, GitTokenError, ProviderKeyError, ProviderKeyGrant, ProviderKeyRequest, RunnerCapabilities, SyncRequest, SyncResponse, TokenRequest } from '@nathapp/fleet-protocol';
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

/** US-003: what one probe request answered. A refusal is the answer the capability isolation needs. */
type ProbeAnswer =
  | { readonly kind: 'ok'; readonly response: SyncResponse }
  | { readonly kind: 'rejected' }
  | { readonly kind: 'woken' }
  | { readonly kind: 'stop'; readonly reason: StopReason }
  | { readonly kind: 'failed'; readonly error: unknown };

/** US-003: a probe that did not answer: a stop, a wake or the ordinary backoff. */
type ProbeFailure = Exclude<ProbeAnswer, { readonly kind: 'ok' } | { readonly kind: 'rejected' }>;

/** US-003: the outcome of the capability isolation. `ambiguous` leaves the batch to its own isolation. */
type CapabilityIsolation =
  | { readonly kind: 'resolved'; readonly outcome: SyncOutcome }
  | { readonly kind: 'ambiguous' };

export interface SyncLoopDeps {
  readonly client: { sync(request: SyncRequest, signal?: AbortSignal): Promise<SyncResponse> };
  readonly journal: Pick<Journal, 'jobsWithPending' | 'pendingEvents' | 'ackThrough' | 'replaceEvent' | 'onWrite'>;
  readonly bootId: string;
  readonly daemonVersion: string;
  readonly freeSlots: () => number;
  readonly capabilityReport: () => CapabilityReport | null;
  readonly onCapabilitiesSent: (hash: string) => void;
  readonly handleCommands: (commands: readonly FleetCommandOut[]) => Promise<CommandAck[]>;
  /**
   * US-001: the jobs the server does not know. Their epochs are retired in the background, so the poll is not held
   * by a cleanup that waits for the repo mutex.
   */
  readonly abandonUnknown: (jobIds: readonly string[]) => void;
  /** Design §3.1: which jobs need a git token now (TokenCache.requests). */
  readonly tokenRequests: () => readonly TokenRequest[];
  /** The server's answer to this request's token requests (TokenCache.apply). */
  readonly onTokens: (requested: readonly TokenRequest[], tokens: readonly GitToken[], errors: readonly GitTokenError[]) => void;
  /** US-008: which provider keys jobs need now (ProviderKeyCache.requests). */
  readonly providerRequests?: () => readonly ProviderKeyRequest[];
  /** US-008: the server's answer to this request's provider requests (ProviderKeyCache.apply). */
  readonly onProviderKeys?: (requested: readonly ProviderKeyRequest[], grants: readonly ProviderKeyGrant[], errors: readonly ProviderKeyError[]) => void;
  /** Fleet S5a §3: the thread ids the server has archived. An absent field keeps the previous list. */
  readonly onArchivedThreads?: (ids: readonly string[]) => void;
  /** US-006: the server requested an immediate capability re-probe. */
  readonly onReprobe?: () => void;
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
  /** US-003: the hash this loop already confirmed. It is not offered again, even if the reporter still returns it. */
  private capsSent: string | null = null;
  private inflight: AbortController | null = null;
  private readonly stopController = new AbortController();
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

  /**
   * US-001: an ack whose command finished after its sync — an ABANDON whose retirement became durable while the
   * poll went on. It rides the next request, and the poll is woken so it does not wait out a long poll for an ack
   * the server is waiting for.
   */
  queueAck(ack: CommandAck): void {
    this.pendingAcks.set(ack.commandId, clampAck(ack));
    this.pendingAcksAt.set(ack.commandId, this.deps.nowMs());
    this.wake();
  }

  stop(): void {
    this.stopped = true;
    this.unsubscribe();
    this.stopController.abort('stop');
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
      if (outcome.kind === 'retry') await this.deps.sleep(outcome.delayMs, this.stopController.signal);
      else if (outcome.kind !== 'again' && !this.dirty) await this.deps.sleep(Math.max(0, this.deps.minGapMs - (this.deps.nowMs() - started)), this.stopController.signal);
    }
  }

  private report(): CapabilityReport | null {
    const report = this.deps.capabilityReport();
    if (!report) return null;
    if (report.hash === this.capsRejected) return null;   // the server refused this hash
    if (report.hash === this.capsSent) return null;       // US-003: this hash is already confirmed
    return report;
  }

  async syncOnce(): Promise<SyncOutcome> {
    const report = this.report();
    this.dirty = false; // anything written from here on is either in this request or marks the next one
    const request = buildSyncRequest({
      journal: this.deps.journal, bootId: this.deps.bootId, daemonVersion: this.deps.daemonVersion, freeSlots: this.deps.freeSlots(),
      acks: this.acksExcluded ? [] : [...this.pendingAcks.values()], capabilities: report?.capabilities, scale: this.scale,
      tokenRequests: this.deps.tokenRequests(),
      providerRequests: this.deps.providerRequests?.() ?? [],
    });
    const controller = new AbortController();
    this.inflightIdle = request.jobs.length === 0 && request.commandAcks.length === 0 && request.tokenRequests.length === 0
      && (request.providerRequests ?? []).length === 0;
    this.inflight = controller;
    try {
      const response = await this.deps.client.sync(request, controller.signal);
      return await this.apply(request, response, report);
    } catch (error) {
      return await this.classify(error, request, controller, report);
    } finally {
      this.inflight = null;
    }
  }

  /**
   * The ordinary response path. `probe` is true for an isolated capability request (US-003): its answer says nothing
   * about the refused batch, so the batch scale, the failure counter and the pending acks keep their state.
   */
  private async apply(request: SyncRequest, response: SyncResponse, report: CapabilityReport | null, probe = false): Promise<SyncOutcome> {
    this.inflightIdle = false; // writes made while commands are handled below must not be aborted, only marked dirty
    for (const ack of response.jobAcks ?? []) {
      const reported = request.jobs.find((job) => job.jobId === ack.jobId);
      if (reported) this.deps.journal.ackThrough(ack.jobId, reported.leaseEpoch, ack.ackedSeq);
    }
    for (const ack of request.commandAcks) {
      this.pendingAcks.delete(ack.commandId);
      this.pendingAcksAt.delete(ack.commandId);   // MEM-1: don't leave a timestamp for a confirmed ack
    }
    if (!probe && this.acksExcluded) this.stripPendingAckDetails();
    if (report && request.capabilities) {
      this.deps.onCapabilitiesSent(report.hash);
      this.capsSent = report.hash;   // US-003: the hash is confirmed; it is not offered again
    }
    if (!probe) {
      this.failures = 0;
      this.scale = doubleScale(this.scale);
    }
    this.deps.onTokens(request.tokenRequests, response.gitTokens ?? [], response.gitTokenErrors ?? []);
    this.deps.onProviderKeys?.(request.providerRequests ?? [], response.providerKeys ?? [], response.providerKeyErrors ?? []);
    // Fleet S5a §3: the prune pass keeps the latest list; a response without the field keeps the previous one.
    if (response.archivedThreadIds !== undefined) this.deps.onArchivedThreads?.(response.archivedThreadIds);
    if (response.reprobe === true) this.deps.onReprobe?.();
    const unknown = response.unknownJobIds ?? [];
    if (unknown.length > 0) this.deps.abandonUnknown(unknown);
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

  private async classify(error: unknown, request: SyncRequest, controller: AbortController, report: CapabilityReport | null): Promise<SyncOutcome> {
    if (controller.signal.aborted) return { kind: 'woken' };
    if (error instanceof ServerError) {
      if (error.status === 426) return { kind: 'stop', reason: { kind: 'protocol', message: error.message } };
      if (error.status === 401) return { kind: 'stop', reason: { kind: 'auth', message: error.message } };
      if (error.status === 400 || error.status === 413) return await this.badBatch(request, controller, report, error);
    }
    return this.retry(error);
  }

  private async badBatch(request: SyncRequest, controller: AbortController, report: CapabilityReport | null, error: ServerError): Promise<SyncOutcome> {
    if (report && request.capabilities && error.status === 400) {
      // US-003: a refused batch does not prove the capabilities are bad. They are tried on their own first.
      const isolation = await this.isolateCapabilities(request, controller, report);
      if (isolation.kind === 'resolved') return isolation.outcome;
      // The cause is still ambiguous: the capabilities are not proven bad, so the batch keeps its own isolation.
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
    const probe: SyncRequest = { ...request, jobs: [] };
    let response: SyncResponse;
    try {
      response = await this.deps.client.sync(probe, controller.signal);
    } catch (probeError) {
      if (controller.signal.aborted) return { kind: 'woken' };
      if (probeError instanceof ServerError && (probeError.status === 401 || probeError.status === 426)) {
        return this.classify(probeError, probe, controller, report);
      }
      return this.retry(probeError);
    }
    if (controller.signal.aborted) return { kind: 'woken' };
    try {
      await this.apply(probe, response, report);
    } catch (applyError) {
      if (controller.signal.aborted) return { kind: 'woken' };
      return this.retry(applyError);
    }
    if (controller.signal.aborted) return { kind: 'woken' };
    const message = `event ${event.seq} (${event.type}) dropped: the server rejected it (${error.status})`;
    this.deps.journal.replaceEvent(job.jobId, job.leaseEpoch, event.seq, 'lifecycle', { level: 'error', message });
    this.deps.log.error(message, { jobId: job.jobId, seq: event.seq, type: event.type });
    this.scale = FULL_SCALE;
    return this.retry(error);
  }

  /**
   * US-003: the attempted capability hash is isolated. The capabilities are sent on their own first; the hash is
   * marked sent when that request succeeds. Only when that request returns 400 AND the same envelope without the
   * capabilities succeeds is the hash suppressed: the base-only control is the positive proof that the capabilities
   * are the cause. An original request that already carried nothing but the capabilities is its own evidence, so it
   * needs no second attempt.
   */
  private async isolateCapabilities(request: SyncRequest, controller: AbortController, report: CapabilityReport): Promise<CapabilityIsolation> {
    if (!this.isCapabilityOnly(request)) {
      const probe = this.capabilityOnlyRequest(request, report.capabilities);
      const answer = await this.probeRequest(probe, controller);
      if (answer.kind !== 'ok' && answer.kind !== 'rejected') return { kind: 'resolved', outcome: this.probeOutcome(answer) };
      if (answer.kind === 'ok') {
        const applied = await this.applyProbe(probe, answer.response, report, controller);
        if (applied.kind !== 'ok') return { kind: 'resolved', outcome: applied.outcome };
        this.deps.log.warn('the capabilities were accepted on their own; the refused batch had another cause', { hash: report.hash });
        return { kind: 'resolved', outcome: { kind: 'again' } };
      }
    }
    // The capabilities are the only thing left the server can refuse: one base-only control decides.
    const control = this.capabilityOnlyRequest(request, undefined);
    const answer = await this.probeRequest(control, controller);
    if (answer.kind !== 'ok' && answer.kind !== 'rejected') return { kind: 'resolved', outcome: this.probeOutcome(answer) };
    if (answer.kind === 'rejected') return { kind: 'ambiguous' };
    const applied = await this.applyProbe(control, answer.response, report, controller);
    if (applied.kind !== 'ok') return { kind: 'resolved', outcome: applied.outcome };
    this.capsRejected = report.hash;
    this.deps.log.error('server rejected the capabilities report; fix runner.json capabilities', { status: 400 });
    return { kind: 'resolved', outcome: { kind: 'again' } };
  }

  /** True when the request carried nothing but the envelope: its own refusal is the isolated evidence. */
  private isCapabilityOnly(request: SyncRequest): boolean {
    return request.jobs.length === 0 && request.commandAcks.length === 0 && request.tokenRequests.length === 0
      && (request.providerRequests ?? []).length === 0;
  }

  /**
   * The capabilities on their own: the same envelope, without jobs, acks or credential requests. Without the
   * capabilities it is the base-only control.
   */
  private capabilityOnlyRequest(request: SyncRequest, capabilities?: RunnerCapabilities): SyncRequest {
    const probe: SyncRequest = {
      ...request,
      jobs: [],
      commandAcks: [],
      tokenRequests: [],
      providerRequests: [],
    };
    if (capabilities) probe.capabilities = capabilities;
    else delete probe.capabilities;
    return probe;
  }

  /**
   * One probe request. Only a 400 is validation rejection evidence; a 401 or 426 stops the loop as before.
   * Other failures, including an ambiguous size refusal (413), retry with the ordinary backoff.
   */
  private async probeRequest(request: SyncRequest, controller: AbortController): Promise<ProbeAnswer> {
    this.inflightIdle = false;   // the probe's answer may carry commands: a journal write must not abort it
    let response: SyncResponse;
    try {
      response = await this.deps.client.sync(request, controller.signal);
    } catch (error) {
      if (controller.signal.aborted) return { kind: 'woken' };
      if (error instanceof ServerError) {
        if (error.status === 401) return { kind: 'stop', reason: { kind: 'auth', message: error.message } };
        if (error.status === 426) return { kind: 'stop', reason: { kind: 'protocol', message: error.message } };
        if (error.status === 400) return { kind: 'rejected' };
      }
      return { kind: 'failed', error };
    }
    if (controller.signal.aborted) return { kind: 'woken' };
    return { kind: 'ok', response };
  }

  /** The outcome of a probe that did not answer: a stop, a wake or the ordinary backoff. */
  private probeOutcome(answer: ProbeFailure): SyncOutcome {
    if (answer.kind === 'woken') return { kind: 'woken' };
    if (answer.kind === 'stop') return { kind: 'stop', reason: answer.reason };
    return this.retry(answer.error);
  }

  /** The probe's answer goes through the ordinary response path, with the fields the probe itself sent. */
  private async applyProbe(
    request: SyncRequest,
    response: SyncResponse,
    report: CapabilityReport,
    controller: AbortController,
  ): Promise<{ kind: 'ok' } | { kind: 'failed'; outcome: SyncOutcome }> {
    try {
      await this.apply(request, response, report, true);
    } catch (error) {
      if (controller.signal.aborted) return { kind: 'failed', outcome: { kind: 'woken' } };
      return { kind: 'failed', outcome: this.retry(error) };
    }
    if (controller.signal.aborted) return { kind: 'failed', outcome: { kind: 'woken' } };
    return { kind: 'ok' };
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
