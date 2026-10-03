import type { ApprovalRequestEventPayload, FleetJobStateName, LogEventPayload, SnapshotEventPayload, StateEventPayload } from '@nathapp/fleet-protocol';
import type { Journal } from '../journal/journal';
import type { JobPatch } from '../journal/types';
import type { Logger } from '../logger';
import { SYNC_LIMITS, byteLength } from '../sync/batch';
import type { WatcherSink } from '../watcher/watcher';
import { canEmit } from './transitions';

const MAX_REASON = 500;
const MAX_MESSAGE = 2_000;
const MAX_LOG_TEXT = 4_000;

/** The only writer of a job's journal events: guards every payload and refuses illegal transitions. */
export class JobEvents implements WatcherSink {
  constructor(private readonly journal: Journal, private readonly jobId: string, private readonly leaseEpoch: number, private readonly log: Logger) {}

  currentState(): FleetJobStateName | null {
    return this.journal.getJob(this.jobId, this.leaseEpoch)?.state ?? null;
  }

  transition(to: FleetJobStateName, reason?: string, patch?: JobPatch): boolean {
    const from = this.currentState();
    if (from === null) return false;
    if (!canEmit(from, to)) {
      const message = `refused illegal transition ${from} -> ${to}`;
      this.log.warn(message, { jobId: this.jobId, leaseEpoch: this.leaseEpoch });
      this.lifecycle('error', message);
      return false;
    }
    const payload: StateEventPayload = { to, ...(reason ? { reason: reason.slice(0, MAX_REASON) } : {}) };
    return this.journal.appendEvent(this.jobId, this.leaseEpoch, 'state', payload, { ...patch, state: to }) !== null;
  }

  snapshot(payload: SnapshotEventPayload): void {
    // `_`-prefixed: ignored by the root eslint varsIgnorePattern '^_'
    const { progress: _progress, ...noProgress } = payload;
    const { stories: _stories, storiesTruncated: _truncated, ...noStories } = payload;
    const { stories: _s, storiesTruncated: _t, ...bare } = noProgress;
    // D151: progress goes first (as before), then the story list; the rest always fits.
    const fitting = [payload, noProgress, noStories].find((candidate) => byteLength(candidate) <= SYNC_LIMITS.payloadBytes) ?? bare;
    this.journal.appendEvent(this.jobId, this.leaseEpoch, 'snapshot', fitting);
  }

  lifecycle(level: 'info' | 'warn' | 'error', message: string, details?: readonly unknown[]): void {
    this.journal.appendEvent(
      this.jobId, this.leaseEpoch, 'lifecycle',
      { level, message: message.slice(0, MAX_MESSAGE), ...(details ? { details: [...details] } : {}) },
    );
  }

  logLine(payload: LogEventPayload): void {
    const fits = byteLength(payload) <= SYNC_LIMITS.payloadBytes;
    this.journal.appendEvent(this.jobId, this.leaseEpoch, 'log', fits ? payload : { ...payload, text: payload.text.slice(0, MAX_LOG_TEXT) });
  }

  /** Spec §4.2 step 4: the ask goes up in the job's report; ask-payload.ts already fit it to the 16 KiB limit. */
  approvalRequest(payload: ApprovalRequestEventPayload): void {
    this.journal.appendEvent(this.jobId, this.leaseEpoch, 'approval_request', payload);
  }
}
