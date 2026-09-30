export type LogFields = Readonly<Record<string, unknown>>;

export interface Logger {
  info(message: string, fields?: LogFields): void;
  warn(message: string, fields?: LogFields): void;
  error(message: string, fields?: LogFields): void;
}

// STYLE-1: anchored to a word boundary OR a camelCase lower→upper case change. Without the case-change branch the
// redaction could not distinguish `apiKey` (a secret field) from `monkey` (an innocent word that contains "key").
// Each option is cased explicitly — the `i` flag would make `[A-Z]` also match lowercase, defeating the boundary.
const SECRET_KEY = /(?:^|(?<=[a-z])(?=[A-Z]))(?:[Kk]ey|[Tt]oken|[Ss]ecret|[Pp]assword|[Aa]uthorization)\b/;
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
