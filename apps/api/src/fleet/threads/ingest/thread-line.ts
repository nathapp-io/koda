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

export interface TurnEndThreadLine {
  type: 'turn_end';
  turnId: string;
  status: TurnEndStatus;
  output: string;
  usage: { inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheWriteTokens: number };
  costUsd: number;
  costSource?: string;
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

export type AssistantThreadLine = TurnStartThreadLine | TextDeltaThreadLine | StreamResetThreadLine | TurnEndThreadLine;

export type ToolThreadLine = ToolCallThreadLine | ToolResultThreadLine | ApprovalRequestedThreadLine | ApprovalResolvedThreadLine;

export type SessionThreadLine = SessionStartedThreadLine | SessionClosedThreadLine | SessionFailedThreadLine;

export type ThreadLine = InputConsumedThreadLine | AssistantThreadLine | ToolThreadLine | QuestionThreadLine | SessionThreadLine;
export type ParsedThreadLine = ThreadLine | { bad: true } | { ignored: true };

const IGNORED_TYPES = new Set(['thinking_delta', 'compaction', 'tool_progress']);
const TURN_ID_MAX = 128;

function replaceNuls(value: unknown): unknown {
  if (typeof value === 'string') return value.replaceAll(String.fromCharCode(0), '\uFFFD');
  if (Array.isArray(value)) return value.map(replaceNuls);
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, replaceNuls(child)]));
  }
  return value;
}

const isString = (value: unknown): value is string => typeof value === 'string';
const isIntegerAtLeastZero = (value: unknown): value is number => Number.isInteger(value) && (value as number) >= 0;
const isTurnId = (value: unknown): value is string => isString(value) && value.length >= 1 && value.length <= TURN_ID_MAX;
const isFiniteNonNegative = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value >= 0;
const isNonEmptyString = (value: unknown, max: number): value is string => isString(value) && value.length >= 1 && value.length <= max;
const isIsoDate = (value: unknown): value is string => isString(value) && !Number.isNaN(Date.parse(value));

/** Keeps the runner's `at` only when it is a string; the fold stamps its own time otherwise. */
function sessionLine<T extends SessionThreadLine>(line: T, at: unknown): T {
  return isString(at) ? { ...line, at } : line;
}

function parseTurnEnd(value: Record<string, unknown>): TurnEndThreadLine | null {
  const usage = value.usage as Record<string, unknown> | null | undefined;
  if (typeof usage !== 'object' || usage === null) return null;
  if (!TURN_END_STATUSES.includes(value.status as TurnEndStatus)) return null;
  if (!isString(value.output) || !isIntegerAtLeastZero(usage.inputTokens) || !isIntegerAtLeastZero(usage.outputTokens)) return null;
  if (usage.cacheReadTokens !== undefined && !isIntegerAtLeastZero(usage.cacheReadTokens)) return null;
  if (usage.cacheWriteTokens !== undefined && !isIntegerAtLeastZero(usage.cacheWriteTokens)) return null;
  if (!isFiniteNonNegative(value.costUsd)) return null;
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
  if (isString(value.costSource)) line.costSource = value.costSource;
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
    parsed = JSON.parse(source.toString('utf8').replace(/\n$/, '').replace(/\r$/, '')) as unknown;
  } catch {
    return { bad: true };
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return { bad: true };
  const value = replaceNuls(parsed) as Record<string, unknown>;
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
      return isTurnId(value.turnId) && isIntegerAtLeastZero(value.round) && isString(value.text)
        ? { type: 'text_delta', turnId: value.turnId, round: value.round, text: value.text }
        : { bad: true };
    case 'stream_reset':
      return isTurnId(value.turnId) && isIntegerAtLeastZero(value.round)
        ? { type: 'stream_reset', turnId: value.turnId, round: value.round }
        : { bad: true };
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
    case 'session_started':
      return typeof value.resumed === 'boolean' ? sessionLine({ type: 'session_started', resumed: value.resumed }, value.at) : { bad: true };
    case 'session_closed':
      return isNonEmptyString(value.reason, 64) ? sessionLine({ type: 'session_closed', reason: value.reason }, value.at) : { bad: true };
    case 'session_failed':
      return isNonEmptyString(value.reason, 64) ? sessionLine({ type: 'session_failed', reason: value.reason }, value.at) : { bad: true };
    default:
      return { bad: true };
  }
}
