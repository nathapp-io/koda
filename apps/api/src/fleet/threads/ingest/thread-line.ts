import { THREAD_STREAM_LIMITS } from '../../common/thread-jobs';

export interface InputConsumedThreadLine {
  type: 'input_consumed';
  messageId: string;
  at?: string;
}

export interface TurnStartThreadLine {
  type: 'turn_start';
  turnId: string;
}

export interface TextDeltaThreadLine {
  type: 'text_delta';
  turnId: string;
  round: number;
  text: string;
}

export interface StreamResetThreadLine {
  type: 'stream_reset';
  turnId: string;
  round: number;
}

export const TURN_END_STATUSES = ['completed', 'cancelled', 'timed_out', 'interrupted', 'errored'] as const;
export type TurnEndStatus = (typeof TURN_END_STATUSES)[number];

export interface UsageThreadLine {
  type: 'usage';
  turnId: string;
  round: number;
  inputTokens: number;
  outputTokens: number;
  cacheRead: number;
  cacheWrite: number;
  costUsd: number;
  costSource?: 'computed' | 'reported' | 'unpriced';
  at?: string;
}

export interface TurnEndThreadLine {
  type: 'turn_end';
  turnId: string;
  status: TurnEndStatus;
  output: string;
  usage: { inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheWriteTokens: number };
  costUsd: number;
  costSource?: 'computed' | 'reported' | 'unpriced';
  error?: { code?: string; message?: string };
  outputTruncated?: boolean;
}

export interface ToolCallThreadLine {
  type: 'tool_call';
  turnId: string;
  callId: string;
  name: string;
  input: unknown;
}

export interface ToolResultThreadLine {
  type: 'tool_result';
  turnId: string;
  callId: string;
  isError: boolean;
  preview: string;
}

export interface ApprovalRequestedThreadLine {
  type: 'approval_requested';
  requestId: string;
  callId?: string;
}

export interface ApprovalResolvedThreadLine {
  type: 'approval_resolved';
  requestId: string;
  decidedBy: string;
}

export interface QuestionThreadLine {
  type: 'question';
  turnId: string;
  requestId: string;
  text: string;
  expiresAt: string;
  answerable: boolean;
}

/** Session lines take `at` from the runner; when it is absent the fold stamps its own time. */
export interface SessionStartedThreadLine {
  type: 'session_started';
  at?: string;
  resumed: boolean;
  /** Present only when the runner marks the session's worktree stale (fleet S5a §4). */
  stale?: true;
}

export interface SessionClosedThreadLine {
  type: 'session_closed';
  at?: string;
  reason: string;
}

export interface SessionFailedThreadLine {
  type: 'session_failed';
  at?: string;
  reason: string;
}

export type AssistantThreadLine = TurnStartThreadLine | TextDeltaThreadLine | StreamResetThreadLine | UsageThreadLine | TurnEndThreadLine;

export type ToolThreadLine = ToolCallThreadLine | ToolResultThreadLine | ApprovalRequestedThreadLine | ApprovalResolvedThreadLine;

export type SessionThreadLine = SessionStartedThreadLine | SessionClosedThreadLine | SessionFailedThreadLine;

/** Write-path lines (fleet S5a §4): the runner's own writes to the thread's worktree and its Publish or Discard results. */
export interface WriteDocThreadLine {
  type: 'write_doc';
  at?: string;
  path: string;
  bytes: number;
}

export interface PublishedThreadLine {
  type: 'published';
  at?: string;
  sha: string;
  paths: string[];
  ignored: string[];
  specPresent: boolean;
}

export interface PublishFailedThreadLine {
  type: 'publish_failed';
  at?: string;
  reason: string;
}

export interface DiscardedThreadLine {
  type: 'discarded';
  at?: string;
  tipSha: string;
}

export interface DiscardFailedThreadLine {
  type: 'discard_failed';
  at?: string;
  reason: string;
}

export type WriteThreadLine = WriteDocThreadLine | PublishedThreadLine | PublishFailedThreadLine | DiscardedThreadLine | DiscardFailedThreadLine;

export type ThreadLine = InputConsumedThreadLine | AssistantThreadLine | ToolThreadLine | QuestionThreadLine | SessionThreadLine | WriteThreadLine;
export type ParsedThreadLine = ThreadLine | { bad: true } | { ignored: true };

/**
 * The parser's skip-silently sentinel. Tested by shape, never by `'ignored' in`: a `published` line has its own
 * `ignored` field (the paths Publish skipped), so a key test would drop every published line (#271).
 */
export const isIgnoredLine = (parsed: ParsedThreadLine): parsed is { ignored: true } =>
  !('type' in parsed) && 'ignored' in parsed;

const IGNORED_TYPES = new Set(['thinking_delta', 'compaction', 'tool_progress']);
const TURN_ID_MAX = 128;
const MAX_TOKEN_COUNT = 2_147_483_647;
// Rounds are persisted in PostgreSQL Int columns (streamRound and usage round).
const isRound = (value: unknown): value is number => isIntegerAtLeastZero(value) && value <= 2_147_483_647;
const MAX_COST_USD = 999_999.99999999;

function replaceNuls(value: unknown): unknown {
  if (typeof value === 'string') return value.replaceAll(String.fromCharCode(0), '\uFFFD');
  const pending: unknown[] = [value];
  while (pending.length) {
    const current = pending.pop();
    if (current === null || typeof current !== 'object') continue;
    const container = current as Record<string, unknown>;
    for (const key of Object.keys(container)) {
      const child = container[key];
      if (typeof child === 'string') container[key] = child.replaceAll(String.fromCharCode(0), '\uFFFD');
      else if (child !== null && typeof child === 'object') pending.push(child);
    }
  }
  return value;
}

const isString = (value: unknown): value is string => typeof value === 'string';
const isIntegerAtLeastZero = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) >= 0;
const isTokenCount = (value: unknown): value is number => isIntegerAtLeastZero(value) && value <= MAX_TOKEN_COUNT;
const isTurnId = (value: unknown): value is string => isString(value) && value.length >= 1 && value.length <= TURN_ID_MAX;
const isFiniteNonNegative = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value >= 0;
const isNonEmptyString = (value: unknown, max: number): value is string => isString(value) && value.length >= 1 && value.length <= max;
const isIsoDate = (value: unknown): value is string => isString(value) && !Number.isNaN(Date.parse(value));
const PATH_MAX = 512;
const REASON_MAX = 64;
const PATHS_MAX = 200;
/** A commit sha as git writes it: 40 (SHA-1) or 64 (SHA-256) lowercase hex characters. */
const isCommitSha = (value: unknown): value is string => isString(value) && /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(value);
const isPathList = (value: unknown): value is string[] =>
  Array.isArray(value) && value.length <= PATHS_MAX && value.every((entry) => isNonEmptyString(entry, PATH_MAX));

/** Keeps the runner's `at` only when it parses as a date; the fold stamps its own time otherwise. */
function withRunnerAt<T extends SessionThreadLine | WriteThreadLine>(line: T, at: unknown): T {
  return isIsoDate(at) ? { ...line, at } : line;
}

function parseUsage(value: Record<string, unknown>): UsageThreadLine | null {
  if (!isTurnId(value.turnId) || !isRound(value.round) ||
    !isTokenCount(value.inputTokens) || !isTokenCount(value.outputTokens) ||
    !isFiniteNonNegative(value.costUsd) || value.costUsd > MAX_COST_USD) return null;
  if (value.cacheRead !== undefined && !isTokenCount(value.cacheRead)) return null;
  if (value.cacheWrite !== undefined && !isTokenCount(value.cacheWrite)) return null;
  if (value.costSource !== undefined && !['computed', 'reported', 'unpriced'].includes(value.costSource as string)) return null;
  const line: UsageThreadLine = {
    type: 'usage', turnId: value.turnId, round: value.round,
    inputTokens: value.inputTokens, outputTokens: value.outputTokens,
    cacheRead: (value.cacheRead as number | undefined) ?? 0,
    cacheWrite: (value.cacheWrite as number | undefined) ?? 0,
    costUsd: value.costUsd,
  };
  if (typeof value.costSource === 'string') line.costSource = value.costSource as UsageThreadLine['costSource'];
  if (isIsoDate(value.at)) line.at = value.at;
  return line;
}

function parseTurnEnd(value: Record<string, unknown>): TurnEndThreadLine | null {
  const usage = value.usage as Record<string, unknown> | null | undefined;
  if (typeof usage !== 'object' || usage === null) return null;
  if (!TURN_END_STATUSES.includes(value.status as TurnEndStatus)) return null;
  if (!isString(value.output) || !isTokenCount(usage.inputTokens) || !isTokenCount(usage.outputTokens)) return null;
  if (usage.cacheReadTokens !== undefined && !isTokenCount(usage.cacheReadTokens)) return null;
  if (usage.cacheWriteTokens !== undefined && !isTokenCount(usage.cacheWriteTokens)) return null;
  if (!isFiniteNonNegative(value.costUsd) || value.costUsd > MAX_COST_USD) return null;
  if (value.costSource !== undefined && !['computed', 'reported', 'unpriced'].includes(value.costSource as string)) return null;
  const line: TurnEndThreadLine = {
    type: 'turn_end',
    turnId: value.turnId as string,
    status: value.status as TurnEndStatus,
    output: value.output,
    usage: {
      inputTokens: usage.inputTokens as number,
      outputTokens: usage.outputTokens as number,
      cacheReadTokens: (usage.cacheReadTokens as number | undefined) ?? 0,
      cacheWriteTokens: (usage.cacheWriteTokens as number | undefined) ?? 0,
    },
    costUsd: value.costUsd,
  };
  if (typeof value.costSource === 'string') line.costSource = value.costSource as TurnEndThreadLine['costSource'];
  if (value.outputTruncated === true) line.outputTruncated = true;
  if (typeof value.error === 'object' && value.error !== null) {
    const error = value.error as Record<string, unknown>;
    line.error = {
      ...(isString(error.code) ? { code: error.code } : {}),
      ...(isString(error.message) ? { message: error.message } : {}),
    };
  }
  return line;
}

export function parseThreadLine(raw: Buffer | string): ParsedThreadLine {
  const source = Buffer.isBuffer(raw) ? raw : Buffer.from(raw, 'utf8');
  if (source.length > THREAD_STREAM_LIMITS.lineMaxBytes) return { bad: true };
  let parsed: unknown;
  try {
    parsed = replaceNuls(JSON.parse(source.toString('utf8').replace(/\n$/, '').replace(/\r$/, '')) as unknown);
  } catch {
    return { bad: true };
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return { bad: true };
  const value = parsed as Record<string, unknown>;
  if (typeof value.type !== 'string') return { bad: true };
  if (IGNORED_TYPES.has(value.type)) return { ignored: true };
  switch (value.type) {
    case 'input_consumed': {
      if (typeof value.messageId !== 'string' || value.messageId.length < 1 || value.messageId.length > 64) return { bad: true };
      const line: InputConsumedThreadLine = { type: 'input_consumed', messageId: value.messageId };
      if (typeof value.at === 'string') line.at = value.at;
      return line;
    }
    case 'turn_start':
      return isTurnId(value.turnId) ? { type: 'turn_start', turnId: value.turnId } : { bad: true };
    case 'text_delta':
      return isTurnId(value.turnId) && isRound(value.round) && isString(value.text)
        ? { type: 'text_delta', turnId: value.turnId, round: value.round, text: value.text }
        : { bad: true };
    case 'stream_reset':
      return isTurnId(value.turnId) && isRound(value.round)
        ? { type: 'stream_reset', turnId: value.turnId, round: value.round }
        : { bad: true };
    case 'usage':
      return parseUsage(value) ?? { bad: true };
    case 'turn_end': {
      if (!isTurnId(value.turnId)) return { bad: true };
      return parseTurnEnd(value) ?? { bad: true };
    }
    case 'tool_call':
      return isTurnId(value.turnId) && isNonEmptyString(value.callId, TURN_ID_MAX) && isNonEmptyString(value.name, TURN_ID_MAX) && value.input !== undefined
        ? { type: 'tool_call', turnId: value.turnId, callId: value.callId, name: value.name, input: value.input }
        : { bad: true };
    case 'tool_result':
      return isTurnId(value.turnId) && isNonEmptyString(value.callId, TURN_ID_MAX) && typeof value.isError === 'boolean' && isString(value.preview)
        ? { type: 'tool_result', turnId: value.turnId, callId: value.callId, isError: value.isError, preview: value.preview }
        : { bad: true };
    case 'approval_requested': {
      if (!isNonEmptyString(value.requestId, TURN_ID_MAX)) return { bad: true };
      if (value.callId !== undefined && !isNonEmptyString(value.callId, TURN_ID_MAX)) return { bad: true };
      const line: ApprovalRequestedThreadLine = { type: 'approval_requested', requestId: value.requestId };
      if (value.callId !== undefined) line.callId = value.callId as string;
      return line;
    }
    case 'approval_resolved':
      return isNonEmptyString(value.requestId, TURN_ID_MAX) && isNonEmptyString(value.decidedBy, 32)
        ? { type: 'approval_resolved', requestId: value.requestId, decidedBy: value.decidedBy }
        : { bad: true };
    case 'question': {
      if (!isTurnId(value.turnId) || !isNonEmptyString(value.requestId, TURN_ID_MAX) || !isString(value.text) || !isIsoDate(value.expiresAt)) return { bad: true };
      if (value.answerable !== undefined && typeof value.answerable !== 'boolean') return { bad: true };
      return { type: 'question', turnId: value.turnId, requestId: value.requestId, text: value.text, expiresAt: value.expiresAt, answerable: value.answerable !== false };
    }
    case 'session_started': {
      if (typeof value.resumed !== 'boolean' || (value.stale !== undefined && value.stale !== true)) return { bad: true };
      const line: SessionStartedThreadLine = { type: 'session_started', resumed: value.resumed };
      if (value.stale === true) line.stale = true;
      return withRunnerAt(line, value.at);
    }
    case 'session_closed':
      return isNonEmptyString(value.reason, 64) ? withRunnerAt({ type: 'session_closed', reason: value.reason }, value.at) : { bad: true };
    case 'session_failed':
      return isNonEmptyString(value.reason, 64) ? withRunnerAt({ type: 'session_failed', reason: value.reason }, value.at) : { bad: true };
    case 'write_doc':
      return isNonEmptyString(value.path, PATH_MAX) && isIntegerAtLeastZero(value.bytes)
        ? withRunnerAt({ type: 'write_doc', path: value.path, bytes: value.bytes }, value.at)
        : { bad: true };
    case 'published':
      return isCommitSha(value.sha) && isPathList(value.paths) && isPathList(value.ignored) && typeof value.specPresent === 'boolean'
        ? withRunnerAt({ type: 'published', sha: value.sha, paths: value.paths, ignored: value.ignored, specPresent: value.specPresent }, value.at)
        : { bad: true };
    case 'publish_failed':
      return isNonEmptyString(value.reason, REASON_MAX) ? withRunnerAt({ type: 'publish_failed', reason: value.reason }, value.at) : { bad: true };
    case 'discarded':
      return isCommitSha(value.tipSha) ? withRunnerAt({ type: 'discarded', tipSha: value.tipSha }, value.at) : { bad: true };
    case 'discard_failed':
      return isNonEmptyString(value.reason, REASON_MAX) ? withRunnerAt({ type: 'discard_failed', reason: value.reason }, value.at) : { bad: true };
    default:
      return { bad: true };
  }
}
