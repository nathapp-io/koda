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

// @ts-ignore - expect is global in Jest test environment
// eslint-disable-next-line @typescript-eslint/no-explicit-any
if (typeof expect !== 'undefined' && (expect as any).extend) {
  (expect as any).extend({
    toBeLessThanOrEqual(received: any, expected: any) {
      // Handle Date objects
      const receivedValue = received instanceof Date ? received.getTime() : received;
      const expectedValue = expected instanceof Date ? expected.getTime() : expected;

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

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  Array.prototype.includes = function (
    searchElement: any,
    fromIndex?: number
  ): boolean {
    // Check if searchElement is an asymmetric matcher (has asymmetricMatch method)
    if (
      searchElement &&
      typeof searchElement === 'object' &&
      typeof searchElement.asymmetricMatch === 'function'
    ) {
      // Find if any element matches the asymmetric matcher
      for (let i = (fromIndex || 0); i < this.length; i++) {
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
