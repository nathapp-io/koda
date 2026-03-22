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
}

/**
 * Handle API errors and exit with appropriate code.
 * Exit codes:
 *   - 1: general API error (5xx, unknown)
 *   - 2: auth error (401, 403)
 *   - 3: validation error (400)
 *   - 4: not found (404)
 */
export function handleApiError(err: unknown, opts?: HandleApiErrorOpts): never {
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
    process.exit(4);
  }

  printError(errorMessage);
  process.exit(1);
}
