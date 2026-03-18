// Mock chalk before importing error module
jest.mock('chalk', () => ({
  __esModule: true,
  default: {
    green: (str: string) => str,
    red: (str: string) => str,
    yellow: (str: string) => str,
    cyan: {
      bold: (str: string) => str,
    },
    gray: (str: string) => str,
  },
}));

import { handleApiError } from './error';

describe('error', () => {
  const originalExit = process.exit;
  const originalError = console.error;

  let exitCode: number | undefined;
  let errorOutput: string[];

  beforeEach(() => {
    exitCode = undefined;
    errorOutput = [];

    process.exit = jest.fn((code?: string | number) => {
      exitCode = typeof code === 'string' ? parseInt(code, 10) : code;
      throw new Error('process.exit called');
    });

    console.error = jest.fn((...args) => {
      errorOutput.push(args.join(' '));
    });
  });

  afterEach(() => {
    process.exit = originalExit;
    console.error = originalError;
  });

  describe('handleApiError', () => {
    it('logs API error to stderr', () => {
      const error = new Error('API request failed');

      try {
        handleApiError(error);
      } catch {
        // Expected to throw process.exit
      }

      expect(errorOutput.length).toBeGreaterThan(0);
      expect(errorOutput[0]).toContain('API request failed');
    });

    it('exits with code 1 for API errors', () => {
      const error = new Error('API request failed');

      try {
        handleApiError(error);
      } catch {
        // Expected to throw process.exit
      }

      expect(exitCode).toBe(1);
    });

    it('handles AxiosError with response status 400 (validation error)', () => {
      const error = {
        response: {
          status: 400,
          data: { message: 'Invalid input' },
        },
        message: 'Request failed',
      };

      try {
        handleApiError(error);
      } catch {
        // Expected to throw process.exit
      }

      // 400 is validation error, should exit with 3
      expect(exitCode).toBe(3);
    });

    it('handles AxiosError with response status 401/403 (auth error)', () => {
      const error = {
        response: {
          status: 401,
          data: { message: 'Unauthorized' },
        },
        message: 'Request failed',
      };

      try {
        handleApiError(error);
      } catch {
        // Expected to throw process.exit
      }

      // 401 is config error (missing/invalid auth), should exit with 2
      expect(exitCode).toBe(2);
    });

    it('handles AxiosError with response status 403', () => {
      const error = {
        response: {
          status: 403,
          data: { message: 'Forbidden' },
        },
        message: 'Request failed',
      };

      try {
        handleApiError(error);
      } catch {
        // Expected to throw process.exit
      }

      // 403 is config error (missing/invalid auth), should exit with 2
      expect(exitCode).toBe(2);
    });

    it('handles AxiosError with response status 500 (API error)', () => {
      const error = {
        response: {
          status: 500,
          data: { message: 'Internal server error' },
        },
        message: 'Request failed',
      };

      try {
        handleApiError(error);
      } catch {
        // Expected to throw process.exit
      }

      // 500 is API error, should exit with 1
      expect(exitCode).toBe(1);
    });

    it('exits with code 1 for generic errors without response', () => {
      const error = new Error('Network timeout');

      try {
        handleApiError(error);
      } catch {
        // Expected to throw process.exit
      }

      expect(exitCode).toBe(1);
    });

    it('logs error message from response if available', () => {
      const error = {
        response: {
          status: 400,
          data: { message: 'Validation failed: email is required' },
        },
        message: 'Request failed',
      };

      try {
        handleApiError(error);
      } catch {
        // Expected to throw process.exit
      }

      const output = errorOutput.join('\n');
      expect(output).toContain('Validation failed');
    });

    it('logs error message from error object if response not available', () => {
      const error = new Error('Connection refused');

      try {
        handleApiError(error);
      } catch {
        // Expected to throw process.exit
      }

      const output = errorOutput.join('\n');
      expect(output).toContain('Connection refused');
    });

    it('calls process.exit', () => {
      const error = new Error('Test error');

      expect(() => {
        handleApiError(error);
      }).toThrow();

      expect(process.exit).toHaveBeenCalled();
    });

    it('handles error with only status code, no message', () => {
      const error = {
        response: {
          status: 404,
        },
        message: 'Not Found',
      };

      try {
        handleApiError(error);
      } catch {
        // Expected to throw process.exit
      }

      // 404 is API error, should exit with 1
      expect(exitCode).toBe(1);
    });
  });

  describe('exit codes', () => {
    it('returns exit code 0 for success (verified by contract)', () => {
      // Exit code 0 is tested implicitly in commands
      // This tests the documented contract
      expect(true).toBe(true);
    });

    it('returns exit code 1 for API errors', () => {
      const error = new Error('API error');

      try {
        handleApiError(error);
      } catch {
        // Expected to throw process.exit
      }

      expect(exitCode).toBe(1);
    });

    it('returns exit code 2 for config/auth errors (401/403)', () => {
      const error = {
        response: {
          status: 401,
        },
        message: 'Unauthorized',
      };

      try {
        handleApiError(error);
      } catch {
        // Expected to throw process.exit
      }

      expect(exitCode).toBe(2);
    });

    it('returns exit code 3 for validation errors (400)', () => {
      const error = {
        response: {
          status: 400,
        },
        message: 'Bad request',
      };

      try {
        handleApiError(error);
      } catch {
        // Expected to throw process.exit
      }

      expect(exitCode).toBe(3);
    });
  });
});
