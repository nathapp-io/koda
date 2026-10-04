import type { LogStreamName } from './domain/fleet-job-log.domain';
import type { LineSpan } from './log-lines';

export const LOG_LEVELS = ['debug', 'info', 'warn', 'error'] as const;
export type LogLevel = (typeof LOG_LEVELS)[number];

const RANK: ReadonlyMap<string, number> = new Map(LOG_LEVELS.map((level, i) => [level, i]));

export const isLogLevel = (v: unknown): v is LogLevel => typeof v === 'string' && RANK.has(v);

export interface LogFilter {
  /** Minimum level (run stream). */
  level?: LogLevel;
  storyId?: string;
  stage?: string;
  /** nax `sessionRole`. */
  role?: string;
  /** Case-insensitive substring of the raw line (R11). */
  q?: string;
}

/** Spec §3.3 / D339: one entry of the entries route. */
export interface LogEntryView {
  offset: number;
  length: number;
  unparsed?: true;
  truncatedLine?: true;
  text?: string;
  timestamp?: string;
  level?: LogLevel;
  stage?: string;
  storyId?: string;
  sessionRole?: string;
  message?: string;
  data?: unknown;
}

type ParsedEntry = Pick<LogEntryView, 'timestamp' | 'stage' | 'storyId' | 'sessionRole' | 'message' | 'data'> & { level: LogLevel };

const hasStructuredFilter = (f: LogFilter): boolean => Boolean(f.level || f.storyId || f.stage || f.role);

function decodeLine(raw: Buffer): string {
  const body = raw.length > 0 && raw[raw.length - 1] === 0x0a ? raw.subarray(0, raw.length - 1) : raw;
  return body.toString('utf8');
}

const str = <K extends string>(key: K, value: unknown): Partial<Record<K, string>> =>
  (typeof value === 'string' ? ({ [key]: value } as Record<K, string>) : {});

/** A nax LogEntry, or null when the line is not a JSON object with a known level. */
function parseLogEntry(text: string): ParsedEntry | null {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return null;
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  const o = value as Record<string, unknown>;
  if (!isLogLevel(o['level'])) return null;
  return {
    level: o['level'],
    ...str('timestamp', o['timestamp']),
    ...str('stage', o['stage']),
    ...str('storyId', o['storyId']),
    ...str('sessionRole', o['sessionRole']),
    ...str('message', o['message']),
    ...('data' in o ? { data: o['data'] } : {}),
  };
}

function matches(e: ParsedEntry, f: LogFilter): boolean {
  if (f.level && (RANK.get(e.level) ?? 0) < (RANK.get(f.level) ?? 0)) return false;
  if (f.storyId !== undefined && e.storyId !== f.storyId) return false;
  if (f.stage !== undefined && e.stage !== f.stage) return false;
  if (f.role !== undefined && e.sessionRole !== f.role) return false;
  return true;
}

/** Spec §3.3 (D339, D340): the entry for one span, or null when the filter rejects it. `raw` is the span's bytes. */
export function toEntry(stream: LogStreamName, span: LineSpan, raw: Buffer, f: LogFilter): LogEntryView | null {
  const text = decodeLine(raw);
  if (f.q && !text.toLowerCase().includes(f.q.toLowerCase())) return null;
  const base = { offset: span.start, length: span.end - span.start, ...(span.cut ? { truncatedLine: true as const } : {}) };
  if (stream !== 'run') return { ...base, text };
  const parsed = span.cut ? null : parseLogEntry(text);
  if (!parsed) return hasStructuredFilter(f) ? null : { ...base, unparsed: true, text };
  return matches(parsed, f) ? { ...base, ...parsed } : null;
}
