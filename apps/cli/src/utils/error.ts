import { error as printError } from './output';
import { isJsonMode } from './json-mode';

interface HandleApiErrorOpts {
  notFoundMessage?: string;
  configError?: boolean;
  validationError?: boolean;
}

type ErrorCode = 'CONFIG_ERROR' | 'VALIDATION_ERROR' | 'UNAUTHORIZED' | 'NOT_FOUND' | 'API_ERROR';

/**
 * Print an error either as colorized text to stderr (default) or, under
 * --json, as a single machine-readable JSON object to stderr — so scripts
 * that parse --json output don't have to also scrape colorized text, and
 * stdout stays reserved for successful command output.
 */
function emitError(message: string, code: ErrorCode, status: number | undefined, hint?: string): void {
  if (isJsonMode()) {
    console.error(JSON.stringify({ error: { code, message, status: status ?? null, hint: hint ?? null } }, null, 2));
    return;
  }

  printError(message);
  if (hint) {
    printError(hint);
  }
}

function describeMessage(m: unknown): string | undefined {
  if (typeof m === 'string') {
    return m;
  }
  // Nest ValidationPipe rejects with `message: string[]`
  if (Array.isArray(m)) {
    return m.map(String).join('; ');
  }
  return undefined;
}

function getStatusAndMessage(err: unknown): { status: number | undefined; message: string } {
  if (typeof err === 'string') {
    return { status: undefined, message: err || 'Unknown error' };
  }

  const e = err as {
    message?: unknown;
    statusCode?: number;
    status?: number;
  } | null;

  // The generated client throws the parsed error body for HTTP failures
  // (e.g. Nest's { statusCode, message }); `.status` is bridged for errors
  // that carry it directly.
  const status = e?.statusCode ?? e?.status;
  if (typeof status === 'number') {
    return { status, message: describeMessage(e?.message) ?? 'Unknown error' };
  }

  // Transport-level errors shaped like { response: { status, data } }
  const apiError = e as {
    response?: { status: number; data?: { message?: string } };
  } | null;
  if (apiError?.response) {
    const message =
      apiError.response.data?.message ??
      describeMessage(e?.message) ??
      'Unknown error';
    return { status: apiError.response.status, message };
  }

  return {
    status: undefined,
    message: describeMessage(e?.message) ?? 'Unknown error',
  };
}

/**
 * Handle API errors and exit with appropriate code.
 * Exit codes:
 *   - 0: success
 *   - 1: API error (5xx, unknown)
 *   - 2: config/auth error (401, 403, or config errors)
 *   - 3: validation error (400)
 *   - 4: not found (404)
 */
export function handleApiError(err: unknown, opts?: HandleApiErrorOpts): never {
  if (opts?.configError) {
    const configError = err as { message?: string };
    emitError(configError.message ?? 'Configuration error', 'CONFIG_ERROR', undefined);
    process.exit(2);
  }

  if (opts?.validationError) {
    const validationErr = err as { message?: string };
    emitError(validationErr.message ?? 'Validation error', 'VALIDATION_ERROR', undefined);
    process.exit(3);
  }

  const { status, message } = getStatusAndMessage(err);

  if (status === 401 || status === 403) {
    emitError(message, 'UNAUTHORIZED', status, 'Check your API key: koda config set apiKey <key>');
    process.exit(2);
  }

  if (status === 400) {
    emitError(message, 'VALIDATION_ERROR', status);
    process.exit(3);
  }

  if (status === 404) {
    emitError(opts?.notFoundMessage ?? 'Not found', 'NOT_FOUND', status);
    process.exit(4);
  }

  emitError(message, 'API_ERROR', status);
  process.exit(1);
}
