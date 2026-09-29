export type LogFields = Readonly<Record<string, unknown>>;

export interface Logger {
  info(message: string, fields?: LogFields): void;
  warn(message: string, fields?: LogFields): void;
  error(message: string, fields?: LogFields): void;
}

const SECRET_KEY = /key|token|secret|password|authorization/i;
const MAX_DEPTH = 5;

export function redact(value: unknown, depth = 0): unknown {
  if (depth > MAX_DEPTH) return '[depth]';
  if (Array.isArray(value)) return value.map((item) => redact(item, depth + 1));
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, SECRET_KEY.test(key) ? '[redacted]' : redact(item, depth + 1)]),
    );
  }
  return value;
}

export function createLogger(write: (line: string) => void, now: () => Date = () => new Date()): Logger {
  const emit = (level: string, msg: string, fields: LogFields = {}): void => {
    write(JSON.stringify({ ...(redact(fields) as Record<string, unknown>), ts: now().toISOString(), level, msg }));
  };
  return {
    info: (message, fields) => emit('info', message, fields),
    warn: (message, fields) => emit('warn', message, fields),
    error: (message, fields) => emit('error', message, fields),
  };
}

export function createConsoleLogger(): Logger {
  return createLogger((line) => process.stderr.write(`${line}\n`));
}

export interface MemoryLogger extends Logger {
  readonly lines: ReadonlyArray<{ level: string; message: string; fields: LogFields }>;
}

export function createMemoryLogger(): MemoryLogger {
  const lines: Array<{ level: string; message: string; fields: LogFields }> = [];
  const push = (level: string) => (message: string, fields: LogFields = {}): void => {
    lines.push({ level, message, fields });
  };
  return { lines, info: push('info'), warn: push('warn'), error: push('error') };
}
