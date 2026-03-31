import { error as printError } from './output';
import { ApiError } from '../generated/core/ApiError';

interface HandleApiErrorOpts {
  notFoundMessage?: string;
  configError?: boolean;
  validationError?: boolean;
}

function getStatusAndMessage(err: unknown): { status: number | undefined; message: string } {
  if (err instanceof ApiError) {
    const body = err.body as Record<string, unknown> | undefined;
    const message =
      (typeof body?.message === 'string' ? body.message : undefined) ??
      err.statusText ??
      err.message ??
      'Unknown error';
    return { status: err.status, message };
  }

  const apiError = err as {
    response?: { status: number; data?: { message?: string } };
    message?: string;
  };

  const message =
    apiError.response?.data?.message ??
    apiError.message ??
    'Unknown error';

  return { status: apiError.response?.status, message };
}

/**
 * Handle API errors and exit with appropriate code.
 * Exit codes:
 *   - 0: success
 *   - 1: API error (5xx, 404, unknown)
 *   - 2: config/auth error (401, 403, or config errors)
 *   - 3: validation error (400)
 */
export function handleApiError(err: unknown, opts?: HandleApiErrorOpts): never {
  if (opts?.configError) {
    const configError = err as { message?: string };
    printError(configError.message ?? 'Configuration error');
    process.exit(2);
  }

  if (opts?.validationError) {
    const validationErr = err as { message?: string };
    printError(validationErr.message ?? 'Validation error');
    process.exit(3);
  }

  const { status, message } = getStatusAndMessage(err);

  if (status === 401 || status === 403) {
    printError(message);
    printError('Check your API key: koda config set apiKey <key>');
    process.exit(2);
  }

  if (status === 400) {
    printError(message);
    process.exit(3);
  }

  if (status === 404) {
    printError(opts?.notFoundMessage ?? 'Not found');
    process.exit(1);
  }

  printError(message);
  process.exit(1);
}
