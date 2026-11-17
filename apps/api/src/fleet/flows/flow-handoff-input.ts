import { ValidationAppException } from '@nathapp/nestjs-common';
import type { HandoffRecordFile } from '@nathapp/fleet-protocol';
import { FEATURE_RE, GIT_REF_RE } from '../jobs/dispatch-input';
import { parseFlowCommonInput } from './flow-input';

/**
 * US-003: the handoff limits live in `@nathapp/fleet-protocol`, because the runner enforces them
 * too. The API image does not ship that package, so the API keeps its own copies; a spec pins them
 * equal to the package's (`src/fleet/common/protocol.spec.ts`).
 */
export const HANDOFF_MAX_RUNS = 20;
export const HANDOFF_RECORD_MAX_BYTES = 524288;
export const HANDOFF_RUN_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
export const HANDOFF_RECORD_FILES = ['result.json', 'ledger.md'] as const;

/** US-003: the record's file shape is the protocol's; only the limits above are copied. */
export type HandoffRecordEntry = HandoffRecordFile;
export interface NormalizedHandoffFlowInput {
  remoteUrl: string;
  branch: string;
  roles: { reviewer: string; supervisor: string };
  costCapUsd: string;
  handoff: { feature: string; headSha: string; record: HandoffRecordEntry[] };
}

const HEAD_SHA_RE = /^[a-f0-9]{40}$/;
const MAX_MTIME_MS = 8640000000000000;

function fail(reason: string): never {
  throw new ValidationAppException({ reason }, 'fleet.flowInput');
}
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Parse and bound the handoff create body into a stable JSON-safe shape. */
export function parseFlowHandoffInput(body: unknown): NormalizedHandoffFlowInput {
  if (!isRecord(body) || Object.hasOwn(body, 'features') || !isRecord(body.handoff)) fail('handoff');
  const input = body.handoff;
  if (typeof input.feature !== 'string' || !FEATURE_RE.test(input.feature)) fail('handoff.feature');
  if (typeof input.headSha !== 'string' || !HEAD_SHA_RE.test(input.headSha)) fail('handoff.headSha');
  if (!Array.isArray(input.record) || input.record.length === 0) fail('handoff.record');

  const runSpellings = new Map<string, string>();
  const seenFiles = new Set<string>();
  let totalBytes = 0;
  const record = input.record.map((candidate, index): HandoffRecordEntry => {
    const prefix = `handoff.record.${index}`;
    if (!isRecord(candidate)) fail(prefix);
    if (typeof candidate.runId !== 'string' || !HANDOFF_RUN_ID_RE.test(candidate.runId)) fail(`${prefix}.runId`);
    const foldedRunId = candidate.runId.toLowerCase();
    const existingSpelling = runSpellings.get(foldedRunId);
    if (existingSpelling !== undefined && existingSpelling !== candidate.runId) fail('handoff.record');
    runSpellings.set(foldedRunId, candidate.runId);
    if (typeof candidate.file !== 'string' || !(HANDOFF_RECORD_FILES as readonly string[]).includes(candidate.file)) fail(`${prefix}.file`);
    const identity = `${foldedRunId}/${candidate.file}`;
    if (seenFiles.has(identity)) fail('handoff.record');
    seenFiles.add(identity);
    if (typeof candidate.mtimeMs !== 'number' || !Number.isInteger(candidate.mtimeMs) || candidate.mtimeMs < 0 || candidate.mtimeMs > MAX_MTIME_MS) fail(`${prefix}.mtimeMs`);
    if (typeof candidate.content !== 'string') fail(`${prefix}.content`);
    totalBytes += Buffer.byteLength(candidate.content, 'utf8');
    return { runId: candidate.runId, file: candidate.file as HandoffRecordEntry['file'], mtimeMs: candidate.mtimeMs, content: candidate.content };
  });
  if (runSpellings.size > HANDOFF_MAX_RUNS || totalBytes > HANDOFF_RECORD_MAX_BYTES) fail('handoff.record');

  const resultEntries = record.filter((entry) => entry.file === 'result.json');
  const resultRunIds = new Set(resultEntries.map((entry) => entry.runId.toLowerCase()));
  if (record.some((entry) => entry.file === 'ledger.md' && !resultRunIds.has(entry.runId.toLowerCase())) || resultEntries.length === 0) fail('handoff.record');
  const newestMtime = Math.max(...resultEntries.map((entry) => entry.mtimeMs));
  const newestEntries = resultEntries.filter((entry) => entry.mtimeMs === newestMtime);
  if (newestEntries.length !== 1) fail('handoff.record');
  let newestResult: unknown;
  try { newestResult = JSON.parse(newestEntries[0].content); } catch { fail('handoff.record'); }
  if (!isRecord(newestResult) || newestResult.schemaVersion !== 1 || !isRecord(newestResult.featureWorkflow)) fail('handoff.record');
  const workflow = newestResult.featureWorkflow;
  if (workflow.step !== 'done' || (workflow.outcome !== 'pushed' && workflow.outcome !== 'local-only') || workflow.head !== input.headSha) fail('handoff.record');

  if (!isRecord(body)) fail('handoff');
  const common = parseFlowCommonInput(body, true);
  if (typeof common.remoteUrl !== 'string' || typeof common.branch !== 'string' || !GIT_REF_RE.test(common.branch)) fail('branch');
  return {
    remoteUrl: common.remoteUrl,
    branch: common.branch,
    roles: common.roles,
    costCapUsd: common.costCapUsd,
    handoff: { feature: input.feature, headSha: input.headSha, record },
  };
}

const TERMINAL_STORY_STATUSES = new Set(['passed', 'failed', 'skipped', 'blocked', 'paused', 'regression-failed', 'decomposed']);

/** Read nax PRD branch and story readiness fields. */
export function readHandoffPrd(text: string): { branchName: string | null; pendingStoryIds: string[] } | null {
  let parsed: unknown;
  try { parsed = JSON.parse(text); } catch { return null; }
  if (!isRecord(parsed) || !Array.isArray(parsed.userStories)) return null;
  const pendingStoryIds: string[] = [];
  for (const story of parsed.userStories) {
    if (!isRecord(story) || story.passes === true || (typeof story.status === 'string' && TERMINAL_STORY_STATUSES.has(story.status))) continue;
    if (typeof story.id === 'string') pendingStoryIds.push(story.id);
  }
  return { branchName: typeof parsed.branchName === 'string' ? parsed.branchName : null, pendingStoryIds };
}
