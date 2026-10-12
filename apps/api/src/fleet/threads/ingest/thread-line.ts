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

export type AssistantThreadLine = TurnStartThreadLine | TextDeltaThreadLine | StreamResetThreadLine | TurnEndThreadLine;

export type ThreadLine = InputConsumedThreadLine | AssistantThreadLine;
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
    default:
      return { bad: true };
  }
}
