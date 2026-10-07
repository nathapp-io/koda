import { parseConfigResult } from './config-result';

describe('parseConfigResult (fleet S3 §3, D475)', () => {
  it.each(['ok', 'no_changes', 'drift', 'conflict', 'invalid', 'push_failed', 'pr_failed', 'timeout'])('accepts outcome %s', (outcome) => {
    expect(parseConfigResult({ outcome })).toEqual({ outcome });
  });

  it('keeps files and output within bounds and strips unknown keys', () => {
    const files = Array.from({ length: 50 }, (_, i) => `.nax/rules/r${i}.md`);
    const output = 'x'.repeat(8_192);
    expect(parseConfigResult({ outcome: 'conflict', files, output, extra: 1 })).toEqual({ outcome: 'conflict', files, output });
    expect(parseConfigResult({ outcome: 'drift', files: [] })).toEqual({ outcome: 'drift', files: [] });
  });

  it.each([
    ['null', null],
    ['an array', []],
    ['an unknown outcome', { outcome: 'done' }],
    ['a missing outcome', { files: [] }],
    ['51 files', { outcome: 'drift', files: Array.from({ length: 51 }, (_, i) => `f${i}`) }],
    ['a 513-char file', { outcome: 'drift', files: ['x'.repeat(513)] }],
    ['an empty file name', { outcome: 'drift', files: [''] }],
    ['a non-string file', { outcome: 'drift', files: [7] }],
    ['output over 8 KiB (UTF-8 bytes)', { outcome: 'invalid', output: 'é'.repeat(4_097) }],
    ['a non-string output', { outcome: 'invalid', output: { text: 'x' } }],
  ])('rejects %s', (_label, raw) => {
    expect(parseConfigResult(raw)).toBeNull();
  });
});
