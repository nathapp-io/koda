// Test setup file - runs before each test file
// Load .env.test so tests that bootstrap AppModule have required env vars
import { config } from 'dotenv';
import { resolve } from 'path';
import { Logger } from '@nestjs/common';
config({ path: resolve(__dirname, '.env.test'), quiet: true });

// Mock NestJS Logger to no-ops to reduce test noise
jest.spyOn(Logger.prototype, 'log').mockImplementation(() => {});
jest.spyOn(Logger.prototype, 'error').mockImplementation(() => {});
jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => {});
jest.spyOn(Logger.prototype, 'debug').mockImplementation(() => {});
jest.spyOn(Logger.prototype, 'verbose').mockImplementation(() => {});

// Jest asymmetric matchers (e.g. expect.objectContaining) expose an
// `asymmetricMatch` method; we narrow to this shape rather than using `any`.
interface AsymmetricMatcher {
  asymmetricMatch(other: unknown): boolean;
}

function isAsymmetricMatcher(value: unknown): value is AsymmetricMatcher {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as { asymmetricMatch?: unknown }).asymmetricMatch === 'function'
  );
}

// `expect` is global only inside a Jest environment; guard so this setup file
// stays import-safe elsewhere.
if (typeof expect !== 'undefined' && typeof expect.extend === 'function') {
  expect.extend({
    toBeLessThanOrEqual(received: unknown, expected: unknown) {
      // Handle Date objects
      const receivedValue =
        received instanceof Date ? received.getTime() : (received as number);
      const expectedValue =
        expected instanceof Date ? expected.getTime() : (expected as number);

      const pass = receivedValue <= expectedValue;

      return {
        pass,
        message: () =>
          pass
            ? `expected ${receivedValue} not to be less than or equal to ${expectedValue}`
            : `expected ${receivedValue} to be less than or equal to ${expectedValue}`,
      };
    },
  });

  // Patch Array.prototype.includes to support asymmetric matchers for toContain
  const originalIncludes = Array.prototype.includes;

  Array.prototype.includes = function (
    searchElement: unknown,
    fromIndex?: number
  ): boolean {
    // Check if searchElement is an asymmetric matcher (has asymmetricMatch method)
    if (isAsymmetricMatcher(searchElement)) {
      // Find if any element matches the asymmetric matcher
      for (let i = fromIndex || 0; i < this.length; i++) {
        if (searchElement.asymmetricMatch(this[i])) {
          return true;
        }
      }
      return false;
    }
    // Fall back to original includes for non-matcher values
    return originalIncludes.call(this, searchElement, fromIndex);
  };
}
