import { describe, expect, test } from 'bun:test';
import { CONFIG_RESULT_LIMITS } from '@nathapp/fleet-protocol';
import { byteLength } from '../../sync/batch';
import { CONFIG_RESULT_BUDGET_BYTES, fitConfigResult, tailBytes } from './result-fit';

describe('tailBytes', () => {
  test('keeps the end, never splits a multi-byte character', () => {
    expect(tailBytes('abcdef', 3)).toBe('def');
    expect(tailBytes('short', 100)).toBe('short');
    const euros = '€'.repeat(10);   // 3 bytes each
    const tail = tailBytes(euros, 7);
    expect(tail).toBe('€€');
    expect(tail.includes('�')).toBe(false);
  });
});

describe('fitConfigResult (D491)', () => {
  test('a small result is unchanged', () => {
    expect(fitConfigResult({ outcome: 'conflict', files: ['.nax/rules/a.md'] })).toEqual({ outcome: 'conflict', files: ['.nax/rules/a.md'] });
    expect(fitConfigResult({ outcome: 'ok' })).toEqual({ outcome: 'ok' });
  });
  test('the output tail is capped at the protocol limit and keeps the end', () => {
    const output = `${'x'.repeat(20_000)}THE END`;
    const fitted = fitConfigResult({ outcome: 'invalid', output });
    expect(Buffer.byteLength(fitted.output ?? '')).toBeLessThanOrEqual(CONFIG_RESULT_LIMITS.maxOutputBytes);
    expect(fitted.output?.endsWith('THE END')).toBe(true);
  });
  test('the worst case the spec allows fits the snapshot budget; the outcome always survives', () => {
    const files = Array.from({ length: 60 }, (_, i) => `.nax/rules/${String(i).padStart(3, '0')}${'p'.repeat(490)}.md`);
    const fitted = fitConfigResult({ outcome: 'invalid', files, output: 'o'.repeat(9_000) });
    expect(byteLength(fitted)).toBeLessThanOrEqual(CONFIG_RESULT_BUDGET_BYTES);
    expect(fitted.outcome).toBe('invalid');
    expect((fitted.files ?? []).length).toBeLessThanOrEqual(CONFIG_RESULT_LIMITS.maxFiles);
    expect(fitted.files?.[0]).toBe(files[0]);
  });
  test('a path over the limit is dropped rather than cut (a cut path names the wrong file)', () => {
    expect(fitConfigResult({ outcome: 'drift', files: ['a'.repeat(CONFIG_RESULT_LIMITS.maxFileChars + 1), 'CLAUDE.md'] })).toEqual({ outcome: 'drift', files: ['CLAUDE.md'] });
  });
});
