import { ValidationAppException } from '@nathapp/nestjs-common';
import type { CommandAck, JobReport, RunnerEvent, SyncRequest, TokenRequest } from '../common/protocol';

export const SYNC_LIMITS = Object.freeze({ jobs: 64, eventsPerJob: 500, acks: 256, tokenRequests: 64, payloadBytes: 16_384 });
const EVENT_TYPES: readonly string[] = ['state', 'snapshot', 'lifecycle', 'log', 'approval_request'];
const MAX_INT = 2_147_483_647;

export type ParsedSync = Omit<SyncRequest, 'capabilities'> & { capabilities?: unknown };

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);
const isStr = (v: unknown, max: number): v is string => typeof v === 'string' && v.length > 0 && v.length <= max && !v.includes('\u0000');
const isInt = (v: unknown, min: number, max = MAX_INT): v is number => Number.isInteger(v) && (v as number) >= min && (v as number) <= max;

function fail(reason: string): never {
  throw new ValidationAppException({ reason }, 'fleet.sync');
}

/**
 * Postgres rejects U+0000 in text and jsonb, which would fail the whole job's transaction and
 * make the runner resend forever. Replace it in every payload string and key; resends are
 * sanitised the same way, so dedup still compares like with like.
 */
export function stripNul(value: unknown): unknown {
  if (typeof value === 'string') return value.replaceAll('\u0000', '\uFFFD');
  if (Array.isArray(value)) return value.map(stripNul);
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k.replaceAll('\u0000', '\uFFFD'), stripNul(v)]));
  }
  return value;
}

function list(v: unknown, max: number, name: string): unknown[] {
  if (v === undefined) return [];
  if (!Array.isArray(v) || v.length > max) fail(name);
  return v;
}

function parseEvent(v: unknown): RunnerEvent {
  if (!isObj(v) || !isInt(v.seq, 1) || typeof v.type !== 'string' || !EVENT_TYPES.includes(v.type) || !isObj(v.payload)) fail('event');
  if (Buffer.byteLength(JSON.stringify(v.payload), 'utf8') > SYNC_LIMITS.payloadBytes) fail('event payload too large');
  return { seq: v.seq as number, type: v.type as RunnerEvent['type'], payload: stripNul(v.payload) as RunnerEvent['payload'] };
}

function parseJob(v: unknown): JobReport {
  if (!isObj(v) || !isStr(v.jobId, 64) || !isInt(v.leaseEpoch, 0)) fail('job');
  const events = list(v.events, SYNC_LIMITS.eventsPerJob, 'events').map(parseEvent);
  if (new Set(events.map((e) => e.seq)).size !== events.length) fail('duplicate seq');
  return { jobId: v.jobId as string, leaseEpoch: v.leaseEpoch as number, events };
}

function parseAck(v: unknown): CommandAck {
  if (!isObj(v) || !isStr(v.commandId, 64) || !isInt(v.leaseEpoch, 0) || (v.result !== 'ok' && v.result !== 'rejected')) fail('commandAck');
  if (v.detail !== undefined && (typeof v.detail !== 'string' || v.detail.length > 500 || v.detail.includes('\u0000'))) fail('commandAck detail');
  return { commandId: v.commandId as string, leaseEpoch: v.leaseEpoch as number, result: v.result, ...(v.detail !== undefined ? { detail: v.detail as string } : {}) };
}

function parseTokenRequest(v: unknown): TokenRequest {
  if (!isObj(v) || !isStr(v.jobId, 64) || !isInt(v.leaseEpoch, 0)) fail('tokenRequest');
  return { jobId: v.jobId as string, leaseEpoch: v.leaseEpoch as number };
}

/** Envelope validation of an untrusted runner sync (spec §3.2). Payload semantics: interpretEvent. */
export function parseSyncRequest(raw: unknown): ParsedSync {
  if (!isObj(raw)) fail('body');
  if (!isInt(raw.protocolVersion, 0)) fail('protocolVersion');
  if (!isStr(raw.bootId, 128)) fail('bootId');
  if (!isStr(raw.daemonVersion, 64)) fail('daemonVersion');
  if (!isInt(raw.freeSlots, 0, 64)) fail('freeSlots');
  const jobs = list(raw.jobs, SYNC_LIMITS.jobs, 'jobs').map(parseJob);
  if (new Set(jobs.map((j) => j.jobId)).size !== jobs.length) fail('duplicate job');
  return {
    protocolVersion: raw.protocolVersion as number,
    bootId: raw.bootId as string,
    daemonVersion: raw.daemonVersion as string,
    ...(raw.capabilities !== undefined ? { capabilities: raw.capabilities } : {}),
    freeSlots: raw.freeSlots as number,
    jobs,
    commandAcks: list(raw.commandAcks, SYNC_LIMITS.acks, 'commandAcks').map(parseAck),
    tokenRequests: list(raw.tokenRequests, SYNC_LIMITS.tokenRequests, 'tokenRequests').map(parseTokenRequest),
  };
}
