import { error as printError } from './output';

interface ApiErrorResponse {
  response?: {
    status: number;
    data?: {
      message?: string;
    };
  };
  message?: string;
}

interface HandleApiErrorOpts {
  notFoundMessage?: string;
  configError?: boolean;
  validationError?: boolean;
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
  // Handle config errors (exit code 2)
  if (opts?.configError) {
    const configError = err as { message?: string };
    printError(configError.message ?? 'Configuration error');
    process.exit(2);
  }

  // Handle validation errors (exit code 3)
  if (opts?.validationError) {
    const validationErr = err as { message?: string };
    printError(validationErr.message ?? 'Validation error');
    process.exit(3);
  }

  const apiError = err as ApiErrorResponse;
  const status = apiError.response?.status;

  let errorMessage = '';
  if (apiError.response?.data?.message) {
    errorMessage = apiError.response.data.message;
  } else if (apiError.message) {
    errorMessage = apiError.message;
  } else {
    errorMessage = 'Unknown error';
  }

  if (status === 401 || status === 403) {
    printError(errorMessage);
    printError('Check your API key: koda config set apiKey <key>');
    process.exit(2);
  }

  if (status === 400) {
    printError(errorMessage);
    process.exit(3);
  }

  if (status === 404) {
    printError(opts?.notFoundMessage ?? 'Not found');
    process.exit(1);
  }

  printError(errorMessage);
  process.exit(1);
}
