import { FleetJobState } from '../../common/enums';
import type { FleetJobPatch } from '../jobs/domain/fleet-job.domain';

export type EventEffect =
  | { kind: 'transition'; to: FleetJobState; reason: string | null; exitCode: number | null }
  | { kind: 'mirror'; patch: FleetJobPatch }
  | { kind: 'none' }
  | { kind: 'invalid'; reason: string };

type Obj = Record<string, unknown>;
const STATES: readonly string[] = Object.values(FleetJobState);
const MAX_PROGRESS_BYTES = 4_096;
const MAX_LOG_BYTES = 8_192;
const COST_RE = /^\d{1,8}(\.\d{1,4})?$/;
const SHA_RE = /^[0-9a-f]{7,64}$/;
/** S1b §1.1: `pushed`, `none` or `failed:` plus 1-200 printable ASCII characters. */
const WIP_PUSH_RE = /^(pushed|none|failed:[\x20-\x7e]{1,200})$/;

const str = (v: unknown, max: number): string | undefined => (typeof v === 'string' && v.length > 0 && v.length <= max ? v : undefined);
const strOrNull = (v: unknown, max: number): string | null | undefined => (v === null ? null : str(v, max));

function httpUrl(v: unknown): string | undefined {
  const s = str(v, 500);
  if (!s) return undefined;
  try {
    const u = new URL(s);
    return u.protocol === 'https:' || u.protocol === 'http:' ? s : undefined;
  } catch {
    return undefined;
  }
}

/** Snapshot -> mirror patch. Fields that fail their bound are dropped, not fatal (review focus 5). */
function mirror(p: Obj): FleetJobPatch {
  const heartbeat = typeof p.heartbeatAt === 'string' && !Number.isNaN(Date.parse(p.heartbeatAt)) ? new Date(p.heartbeatAt) : undefined;
  const progress = typeof p.progress === 'object' && p.progress !== null && !Array.isArray(p.progress) &&
    Buffer.byteLength(JSON.stringify(p.progress), 'utf8') <= MAX_PROGRESS_BYTES ? p.progress : undefined;
  const entries: Array<[keyof FleetJobPatch, unknown]> = [
    ['naxRunId', str(p.naxRunId, 128)],
    ['naxLogRunId', str(p.naxLogRunId, 128)],
    ['naxCostRunId', str(p.naxCostRunId, 128)],
    ['progress', progress],
    ['currentStoryId', strOrNull(p.currentStoryId, 128)],
    ['currentPhase', strOrNull(p.currentPhase, 128)],
    ['costSpentUsd', typeof p.costSpentUsd === 'string' && COST_RE.test(p.costSpentUsd) ? p.costSpentUsd : undefined],
    ['lastHeartbeatAt', heartbeat],
    ['finishResult', str(p.finishResult, 64)],
    ['escalationReason', str(p.escalationReason, 2_000)],
    ['resultBranch', str(p.resultBranch, 255)],
    ['resultSha', typeof p.resultSha === 'string' && SHA_RE.test(p.resultSha) ? p.resultSha : undefined],
    ['resultPrUrl', httpUrl(p.resultPrUrl)],
    ['wipPush', typeof p.wipPush === 'string' && WIP_PUSH_RE.test(p.wipPush) ? p.wipPush : undefined],
  ];
  return Object.fromEntries(entries.filter(([, v]) => v !== undefined)) as FleetJobPatch;
}

/** What a stored runner event does to its job (spec §3.2, §5.4). The parser guarantees payload is an object. */
export function interpretEvent(type: string, payload: unknown): EventEffect {
  const p = (payload ?? {}) as Obj;
  switch (type) {
    case 'state': {
      if (typeof p.to !== 'string' || !STATES.includes(p.to)) return { kind: 'invalid', reason: 'state.to' };
      const reason = typeof p.reason === 'string' ? p.reason.slice(0, 500) : null;
      const exitCode = Number.isInteger(p.exitCode) ? (p.exitCode as number) : null;
      return { kind: 'transition', to: p.to as FleetJobState, reason, exitCode };
    }
    case 'snapshot':
      return { kind: 'mirror', patch: mirror(p) };
    case 'log':
      if (typeof p.text !== 'string' || Buffer.byteLength(p.text, 'utf8') > MAX_LOG_BYTES) return { kind: 'invalid', reason: 'log.text' };
      return { kind: 'none' };
    case 'lifecycle':
      return { kind: 'none' };
    default:
      return { kind: 'invalid', reason: `type ${type}` };
  }
}
