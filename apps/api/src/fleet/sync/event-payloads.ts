import { FleetJobState } from '../../common/enums';
import type { BashAsk } from '../approvals/approval-closer';
import type { FleetJobPatch, FleetJobPostRun, FleetJobStory } from '../jobs/domain/fleet-job.domain';
import { parseApprovalRequest } from './approval-request-payload';

export type EventEffect =
  | { kind: 'transition'; to: FleetJobState; reason: string | null; exitCode: number | null }
  | { kind: 'mirror'; patch: FleetJobPatch }
  | { kind: 'approval'; ask: BashAsk }
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

/** S1b §1.2 bounds: the runner's STORY_LIMITS (`apps/runner/src/watcher/prd-stories.ts`). */
const STORIES_MAX = 100;
const STORIES_MAX_BYTES = 8_192;
const STORY_ID_MAX = 128;
const STORY_TITLE_MAX = 80;
const STORY_DEPENDS_MAX = 10;
const STORY_ATTEMPTS_MAX = 1_000_000;
const STORY_STATUS_RE = /^[a-z][a-z-]{0,31}$/;
/** S2b (j) §1.3 bounds: nax stage status strings, passed through (D429). */
const POST_RUN_STAGES = ['acceptance', 'regression', 'finish'] as const;
const STAGE_STATUS_RE = /^[\x20-\x7e]{1,32}$/;

const isStoryId = (v: unknown): boolean => typeof v === 'string' && v.trim() !== '' && v.length <= STORY_ID_MAX;

function story(v: unknown): FleetJobStory | null {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return null;
  const { id, title, status, attempts, dependsOn } = v as Obj;
  if (!isStoryId(id) || typeof title !== 'string' || title.length > STORY_TITLE_MAX) return null;
  if (typeof status !== 'string' || !STORY_STATUS_RE.test(status)) return null;
  if (typeof attempts !== 'number' || !Number.isInteger(attempts) || attempts < 0 || attempts > STORY_ATTEMPTS_MAX) return null;
  if (!Array.isArray(dependsOn) || dependsOn.length > STORY_DEPENDS_MAX || !dependsOn.every(isStoryId)) return null;
  return { id: id as string, title, status, attempts, dependsOn: dependsOn as string[] };
}

/** One bad story drops the whole list: it is one mirrored field (S1b §1.3). */
function storyList(v: unknown): FleetJobStory[] | undefined {
  if (!Array.isArray(v) || v.length > STORIES_MAX || Buffer.byteLength(JSON.stringify(v), 'utf8') > STORIES_MAX_BYTES) return undefined;
  const stories = v.map(story);
  return stories.every((s) => s !== null) ? stories : undefined;
}

/** Known stages with a valid status; undefined (field absent, stored value kept) when none survive (D428). */
export function postRunStages(v: unknown): FleetJobPostRun | undefined {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return undefined;
  const o = v as Obj;
  const kept = POST_RUN_STAGES.flatMap((key): Array<[string, string]> => {
    const value = o[key];
    return typeof value === 'string' && STAGE_STATUS_RE.test(value) ? [[key, value]] : [];
  });
  return kept.length > 0 ? (Object.fromEntries(kept) as FleetJobPostRun) : undefined;
}

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
  const stories = storyList(p.stories);
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
    ['stories', stories],
    ['storiesTruncated', stories === undefined ? undefined : p.storiesTruncated === true],   // D150
    ['postRun', postRunStages(p.postRun)],
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
    case 'approval_request': {
      const parsed = parseApprovalRequest(payload);
      // strictNullChecks is off in apps/api: `parsed.ok` does not narrow, `in` does.
      return 'ask' in parsed ? { kind: 'approval', ask: parsed.ask } : { kind: 'invalid', reason: parsed.reason };
    }
    default:
      return { kind: 'invalid', reason: `type ${type}` };
  }
}
