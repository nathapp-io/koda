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

/**
 * Handle API errors and exit with appropriate code.
 * Exit codes:
 *   - 1: API error (5xx, unknown)
 *   - 2: Config/auth error (401, 403)
 *   - 3: Validation error (400)
 */
export function handleApiError(err: unknown): never {
  const apiError = err as ApiErrorResponse;
  const status = apiError.response?.status;

  // Determine error message
  let errorMessage = '';
  if (apiError.response?.data?.message) {
    errorMessage = apiError.response.data.message;
  } else if (apiError.message) {
    errorMessage = apiError.message;
  } else {
    errorMessage = 'Unknown error';
  }

  // Log error to stderr
  printError(errorMessage);

  // Determine exit code based on HTTP status
  let exitCode = 1; // Default: API error

  if (status === 400) {
    exitCode = 3; // Validation error
  } else if (status === 401 || status === 403) {
    exitCode = 2; // Config/auth error
  }

  process.exit(exitCode);
}
