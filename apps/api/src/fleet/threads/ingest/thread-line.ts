import { THREAD_STREAM_LIMITS } from '../../common/thread-jobs';

export interface InputConsumedThreadLine {
  type: 'input_consumed';
  messageId: string;
  at?: string;
}

export type ThreadLine = InputConsumedThreadLine;
export type ParsedThreadLine = ThreadLine | { bad: true } | { ignored: true };

const IGNORED_TYPES = new Set(['thinking_delta', 'compaction', 'tool_progress']);

function replaceNuls(value: unknown): unknown {
  if (typeof value === 'string') return value.replaceAll(String.fromCharCode(0), '\uFFFD');
  if (Array.isArray(value)) return value.map(replaceNuls);
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, replaceNuls(child)]));
  }
  return value;
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
  if (value.type !== 'input_consumed' || typeof value.messageId !== 'string' || value.messageId.length < 1 || value.messageId.length > 64) {
    return { bad: true };
  }
  const line: InputConsumedThreadLine = { type: 'input_consumed', messageId: value.messageId };
  if (typeof value.at === 'string') line.at = value.at;
  return line;
}
