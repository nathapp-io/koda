import { describe, expect, test } from 'bun:test';
import { errorMessage, firstLine } from './errors';

describe('errors', () => {
  test('errorMessage reads Error, string and unknown values', () => {
    expect(errorMessage(new Error('boom'))).toBe('boom');
    expect(errorMessage('plain')).toBe('plain');
    expect(errorMessage({ a: 1 })).toBe('[object Object]');
  });

  test('firstLine takes the first non-empty line and cuts it', () => {
    expect(firstLine('\n\n  fatal: bad\nsecond')).toBe('fatal: bad');
    expect(firstLine('x'.repeat(300), 50)).toHaveLength(50);
    expect(firstLine('')).toBe('');
  });
});
