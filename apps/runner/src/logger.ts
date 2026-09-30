export type LogFields = Readonly<Record<string, unknown>>;

export interface Logger {
  info(message: string, fields?: LogFields): void;
  warn(message: string, fields?: LogFields): void;
  error(message: string, fields?: LogFields): void;
}

// STYLE-1/SEC-3: a secret word must sit on a segment boundary — start/end, a non-letter (`_`, `-`, space) or a
// camelCase lower→upper case change (splitCamel). The word may be plural. This keeps `monkey`/`monkeyCount`/
// `tokenize`/`xKeyx`/`keyboard` unredacted while `apiKey`, `api_key`, `x-api-key`, `apiKeys`, `keys`, `tokens`,
// `secrets`, `secret_key`, `refresh_token`, `accessTokenHash` and SCREAMING_SNAKE (`API_KEY`) stay redacted.
const SECRET_KEY = /(?:^|[^A-Za-z])(?:key|token|secret|password|authorization)s?(?:$|[^A-Za-z])/i;
const splitCamel = (key: string): string => key.replace(/([a-z0-9])([A-Z])/g, '$1_$2');
const isSecretKey = (key: string): boolean => SECRET_KEY.test(splitCamel(key));
const MAX_DEPTH = 5;

export function redact(value: unknown, depth = 0): unknown {
  if (depth > MAX_DEPTH) return '[depth]';
  if (Array.isArray(value)) return value.map((item) => redact(item, depth + 1));
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, isSecretKey(key) ? '[redacted]' : redact(item, depth + 1)]),
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
