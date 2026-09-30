import { FLEET_PROTOCOL_VERSION, type CommandAck, type JobReport, type RunnerCapabilities, type SyncRequest } from '@nathapp/fleet-protocol';
import type { Journal } from '../journal/journal';

export const SYNC_LIMITS = Object.freeze({ jobs: 64, eventsPerJob: 500, acks: 256, tokenRequests: 64, payloadBytes: 16_384 } as const);
/** Under the server's 1 MiB body cap (D26). */
export const MAX_BODY_BYTES = 900_000;
/** `{"seq":2147483647,"type":"lifecycle","payload":},` is 49 bytes around the payload; rounded up. */
const EVENT_OVERHEAD_BYTES = 64;
/** `{"jobId":"<36-char uuid>","leaseEpoch":2147483647,"events":[]},` is about 90 bytes around the events. */
const JOB_OVERHEAD_BYTES = 100;
export const ACK_DETAIL_MAX = 200;

export interface BatchScale {
  readonly jobs: number;
  readonly events: number;
}

export const FULL_SCALE: BatchScale = Object.freeze({ jobs: SYNC_LIMITS.jobs, events: SYNC_LIMITS.eventsPerJob });

export function halveScale(scale: BatchScale): BatchScale | null {
  if (scale.jobs <= 1 && scale.events <= 1) return null;
  return { jobs: Math.max(1, Math.floor(scale.jobs / 2)), events: Math.max(1, Math.floor(scale.events / 2)) };
}

export function doubleScale(scale: BatchScale): BatchScale {
  return { jobs: Math.min(FULL_SCALE.jobs, scale.jobs * 2), events: Math.min(FULL_SCALE.events, scale.events * 2) };
}

export const byteLength = (value: unknown): number => Buffer.byteLength(JSON.stringify(value), 'utf8');

export interface BuildInput {
  readonly journal: Pick<Journal, 'jobsWithPending' | 'pendingEvents'>;
  readonly bootId: string;
  readonly daemonVersion: string;
  readonly freeSlots: number;
  readonly acks: readonly CommandAck[];
  readonly capabilities?: RunnerCapabilities;
  readonly scale: BatchScale;
}

/** The server allows 500 characters and no NUL; a runner-built detail is shorter and never poisons a request (D59). */
export function clampAck(ack: CommandAck): CommandAck {
  if (ack.detail === undefined) return ack;
  const clean = ack.detail.replaceAll('\u0000', '�');
  if (clean.length <= ACK_DETAIL_MAX) return clean === ack.detail ? ack : { ...ack, detail: clean };
  const last = clean.charCodeAt(ACK_DETAIL_MAX - 1);
  const end = last >= 0xd800 && last <= 0xdbff ? ACK_DETAIL_MAX - 1 : ACK_DETAIL_MAX; // never leave half a surrogate pair
  return { ...ack, detail: clean.slice(0, end) };
}

/**
 * One entry per jobId (D56): the server's parseSyncRequest answers 400 "duplicate job" otherwise. A job that has
 * pending events at two epochs (a requeue) reports the highest epoch first; the older epoch waits for a later sync.
 * First-appearance order is kept, so the oldest waiting job still goes first.
 */
function onePerJob(pending: ReadonlyArray<{ jobId: string; leaseEpoch: number }>): Array<{ jobId: string; leaseEpoch: number }> {
  const highest = new Map<string, number>();
  for (const { jobId, leaseEpoch } of pending) highest.set(jobId, Math.max(highest.get(jobId) ?? 0, leaseEpoch));
  return [...highest].map(([jobId, leaseEpoch]) => ({ jobId, leaseEpoch }));
}

export function buildSyncRequest(input: BuildInput): SyncRequest {
  const freeSlots = Math.min(64, Math.max(0, Math.floor(input.freeSlots)));
  const commandAcks = input.acks.slice(0, SYNC_LIMITS.acks).map(clampAck);
  const head = {
    protocolVersion: FLEET_PROTOCOL_VERSION as number,
    bootId: input.bootId,
    daemonVersion: input.daemonVersion,
    ...(input.capabilities ? { capabilities: input.capabilities } : {}),
    freeSlots,
    commandAcks,
    tokenRequests: [] as SyncRequest['tokenRequests'],
  };
  let budget = MAX_BODY_BYTES - byteLength({ ...head, jobs: [] });
  const jobs: JobReport[] = [];
  let included = 0;
  for (const { jobId, leaseEpoch } of onePerJob(input.journal.jobsWithPending()).slice(0, input.scale.jobs)) {
    const events: JobReport['events'] = [];
    for (const row of input.journal.pendingEvents(jobId, leaseEpoch, Math.min(input.scale.events, SYNC_LIMITS.eventsPerJob))) {
      const size = byteLength(row.payload) + EVENT_OVERHEAD_BYTES + (events.length === 0 ? JOB_OVERHEAD_BYTES : 0);
      if (included > 0 && size > budget) break;
      events.push({ seq: row.seq, type: row.type, payload: row.payload });
      budget -= size;
      included += 1;
    }
    if (events.length > 0) jobs.push({ jobId, leaseEpoch, events });
  }
  return { ...head, jobs };
}
