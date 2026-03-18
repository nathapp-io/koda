import { EXIT, handleApiError } from './error';

describe('Error Utilities', () => {
  const originalExit = process.exit;
  const originalConsoleError = console.error;
  let capturedError: string[] = [];

  beforeEach(() => {
    capturedError = [];
    process.exit = jest.fn() as never;
    console.error = jest.fn((...args) => {
      capturedError.push(args.join(' '));
    });
  });

  afterEach(() => {
    process.exit = originalExit;
    console.error = originalConsoleError;
  });

  describe('EXIT constants', () => {
    it('exports EXIT object with all required exit codes', () => {
      expect(EXIT).toBeDefined();
      expect(EXIT).toHaveProperty('SUCCESS');
      expect(EXIT).toHaveProperty('API_ERROR');
      expect(EXIT).toHaveProperty('CONFIG_ERROR');
      expect(EXIT).toHaveProperty('VALIDATION_ERROR');
    });

    it('EXIT.SUCCESS equals 0', () => {
      expect(EXIT.SUCCESS).toBe(0);
    });

    it('EXIT.API_ERROR equals 1', () => {
      expect(EXIT.API_ERROR).toBe(1);
    });

    it('EXIT.CONFIG_ERROR equals 2', () => {
      expect(EXIT.CONFIG_ERROR).toBe(2);
    });

    it('EXIT.VALIDATION_ERROR equals 3', () => {
      expect(EXIT.VALIDATION_ERROR).toBe(3);
    });

    it('all exit codes are numbers', () => {
      expect(typeof EXIT.SUCCESS).toBe('number');
      expect(typeof EXIT.API_ERROR).toBe('number');
      expect(typeof EXIT.CONFIG_ERROR).toBe('number');
      expect(typeof EXIT.VALIDATION_ERROR).toBe('number');
    });

    it('all exit codes are unique', () => {
      const codes = [EXIT.SUCCESS, EXIT.API_ERROR, EXIT.CONFIG_ERROR, EXIT.VALIDATION_ERROR];
      const uniqueCodes = new Set(codes);
      expect(uniqueCodes.size).toBe(codes.length);
    });
  });

  describe('handleApiError()', () => {
    describe('exit code handling', () => {
      it('exits with code 1 for API errors', () => {
        const error = new Error('API request failed');

        handleApiError(error);

        expect(process.exit).toHaveBeenCalledWith(EXIT.API_ERROR);
      });

      it('exits with code 1 when error status is 4xx', () => {
        const error = new Error('Not found');
        (error as any).response = { status: 404 };

        handleApiError(error);

        expect(process.exit).toHaveBeenCalledWith(EXIT.API_ERROR);
      });

      it('exits with code 1 when error status is 5xx', () => {
        const error = new Error('Internal server error');
        (error as any).response = { status: 500 };

        handleApiError(error);

        expect(process.exit).toHaveBeenCalledWith(EXIT.API_ERROR);
      });

      it('exits with code 1 for network errors', () => {
        const error = new Error('Network timeout');
        (error as any).code = 'ECONNABORTED';

        handleApiError(error);

        expect(process.exit).toHaveBeenCalledWith(EXIT.API_ERROR);
      });
    });

    describe('error message output', () => {
      it('prints error message to stderr', () => {
        const error = new Error('API call failed');

        handleApiError(error);

        expect(console.error).toHaveBeenCalled();
      });

      it('prints the error message text', () => {
        const errorMsg = 'Unauthorized access';
        const error = new Error(errorMsg);

        handleApiError(error);

        expect(capturedError[0]).toContain(errorMsg);
      });

      it('handles errors with response data', () => {
        const error = new Error('Request failed');
        (error as any).response = {
          status: 400,
          data: { message: 'Invalid input' },
        };

        handleApiError(error);

        expect(console.error).toHaveBeenCalled();
      });

      it('handles errors without message property', () => {
        const error = { code: 'UNKNOWN' } as unknown as Error;

        handleApiError(error);

        expect(console.error).toHaveBeenCalled();
      });

      it('prints meaningful error for connection refused', () => {
        const error = new Error('ECONNREFUSED');
        (error as any).code = 'ECONNREFUSED';

        handleApiError(error);

        expect(console.error).toHaveBeenCalled();
      });

      it('prints meaningful error for timeout', () => {
        const error = new Error('Timeout');
        (error as any).code = 'ECONNABORTED';

        handleApiError(error);

        expect(console.error).toHaveBeenCalled();
      });
    });

    describe('error types', () => {
      it('handles Error objects', () => {
        const error = new Error('Test error');

        handleApiError(error);

        expect(process.exit).toHaveBeenCalledWith(EXIT.API_ERROR);
        expect(console.error).toHaveBeenCalled();
      });

      it('handles Error with axios response', () => {
        const error = new Error('Request error');
        (error as any).response = {
          status: 403,
          statusText: 'Forbidden',
          data: { error: 'Access denied' },
        };

        handleApiError(error);

        expect(process.exit).toHaveBeenCalledWith(EXIT.API_ERROR);
      });

      it('handles Error with request but no response', () => {
        const error = new Error('Network error');
        (error as any).request = {};
        (error as any).response = undefined;

        handleApiError(error);

        expect(process.exit).toHaveBeenCalledWith(EXIT.API_ERROR);
      });

      it('handles Error without response or request', () => {
        const error = new Error('Configuration error');

        handleApiError(error);

        expect(process.exit).toHaveBeenCalledWith(EXIT.API_ERROR);
      });
    });

    describe('common API errors', () => {
      it('handles 401 Unauthorized', () => {
        const error = new Error('Unauthorized');
        (error as any).response = {
          status: 401,
          data: { message: 'Invalid API key' },
        };

        handleApiError(error);

        expect(process.exit).toHaveBeenCalledWith(EXIT.API_ERROR);
        expect(console.error).toHaveBeenCalled();
      });

      it('handles 404 Not Found', () => {
        const error = new Error('Not found');
        (error as any).response = {
          status: 404,
          data: { message: 'Resource not found' },
        };

        handleApiError(error);

        expect(process.exit).toHaveBeenCalledWith(EXIT.API_ERROR);
      });

      it('handles 409 Conflict', () => {
        const error = new Error('Conflict');
        (error as any).response = {
          status: 409,
          data: { message: 'Resource already exists' },
        };

        handleApiError(error);

        expect(process.exit).toHaveBeenCalledWith(EXIT.API_ERROR);
      });

      it('handles 500 Internal Server Error', () => {
        const error = new Error('Internal server error');
        (error as any).response = {
          status: 500,
          data: { message: 'Something went wrong' },
        };

        handleApiError(error);

        expect(process.exit).toHaveBeenCalledWith(EXIT.API_ERROR);
      });
    });

    describe('function behavior', () => {
      it('function never returns (always exits)', () => {
        const error = new Error('Test');

        // handleApiError should never return normally
        expect(() => {
          handleApiError(error);
        }).not.toThrow();

        // But it should call process.exit
        expect(process.exit).toHaveBeenCalled();
      });

      it('calls process.exit as a never-returning function', () => {
        // This is a behavior test - the function should call process.exit
        const error = new Error('Test');

        handleApiError(error);

        expect(process.exit).toHaveBeenCalled();
      });
    });

    describe('exit code specificity', () => {
      it('always uses EXIT.API_ERROR (1) for API errors', () => {
        const errors = [
          new Error('Network error'),
          new Error('404 Not Found'),
          new Error('500 Server Error'),
          new Error('Request timeout'),
        ];

        errors.forEach((error) => {
          jest.clearAllMocks();
          handleApiError(error);
          expect(process.exit).toHaveBeenCalledWith(1);
        });
      });

      it('does not use CONFIG_ERROR or VALIDATION_ERROR for API errors', () => {
        const error = new Error('API error');

        handleApiError(error);

        expect(process.exit).not.toHaveBeenCalledWith(EXIT.CONFIG_ERROR);
        expect(process.exit).not.toHaveBeenCalledWith(EXIT.VALIDATION_ERROR);
      });
    });
  });

  describe('handleApiError edge cases', () => {
    it('handles errors with null message', () => {
      const error = new Error();
      (error as any).message = null;

      handleApiError(error);

      expect(process.exit).toHaveBeenCalledWith(EXIT.API_ERROR);
    });

    it('handles errors with very long messages', () => {
      const longMsg = 'x'.repeat(1000);
      const error = new Error(longMsg);

      handleApiError(error);

      expect(console.error).toHaveBeenCalled();
      expect(process.exit).toHaveBeenCalledWith(EXIT.API_ERROR);
    });

    it('handles errors with special characters in message', () => {
      const error = new Error('Error: "quotes" and \'apostrophes\' & ampersands');

      handleApiError(error);

      expect(console.error).toHaveBeenCalled();
    });
  });
});
