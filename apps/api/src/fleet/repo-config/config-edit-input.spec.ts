import { ValidationAppException } from '@nathapp/nestjs-common';
import { validateBaseSha, validateConfigEdits, validatePrBody, validatePrTitle } from './config-edit-input';

const SHA = 'a'.repeat(40);
const put = (path: string, content = 'x', baseSha: string | null = null) => ({ path, op: 'put', content, baseSha });
const reasonOf = (fn: () => unknown): string => {
  // ValidationAppException carries its i18n args on `.args` (see dispatch-input.spec.ts:55).
  try { fn(); } catch (e) { expect(e).toBeInstanceOf(ValidationAppException); return (e as { args: { reason: string } }).args.reason; }
  throw new Error('did not throw');
};

describe('validateConfigEdits (fleet S3 §1, §2)', () => {
  it('returns a clean copy of a valid edit set', () => {
    const edits = validateConfigEdits([put('.nax/rules/a.md', '# a', SHA), { path: '.nax/profiles/old.json', op: 'delete', baseSha: SHA, extra: 1 }]);
    expect(edits).toEqual([
      { path: '.nax/rules/a.md', op: 'put', content: '# a', baseSha: SHA },
      { path: '.nax/profiles/old.json', op: 'delete', baseSha: SHA },
    ]);
  });

  it('accepts exactly 50 edits and 256 KiB per file', () => {
    expect(validateConfigEdits(Array.from({ length: 50 }, (_, i) => put(`.nax/rules/r${i}.md`)))).toHaveLength(50);
    expect(validateConfigEdits([put('.nax/context.md', 'x'.repeat(262_144))])).toHaveLength(1);
  });

  it.each([
    ['not an array', 'x', 'edits'],
    ['empty', [], 'edits'],
    ['51 edits', Array.from({ length: 51 }, (_, i) => put(`.nax/rules/r${i}.md`)), 'edits'],
    ['an env profile', [put('.nax/profiles/fast.env')], '.nax/profiles/fast.env'],
    ['a generated file', [put('AGENTS.md')], 'AGENTS.md'],
    ['a traversal', [put('.nax/rules/../config.json')], 'path'],
    ['a duplicate path', [put('.nax/context.md'), put('.nax/context.md')], 'duplicate'],
    ['a case-insensitive duplicate', [put('.nax/rules/A.md'), put('.nax/rules/a.md')], 'duplicate'],
    ['an unknown op', [{ path: '.nax/context.md', op: 'move', baseSha: null }], 'op'],
    ['put without content', [{ path: '.nax/context.md', op: 'put', baseSha: null }], 'content'],
    ['delete with content', [{ path: '.nax/context.md', op: 'delete', content: 'x', baseSha: SHA }], 'content'],
    ['delete of a new file', [{ path: '.nax/context.md', op: 'delete', baseSha: null }], 'baseSha'],
    ['a bad baseSha', [put('.nax/context.md', 'x', 'xyz')], 'baseSha'],
    ['an uppercase baseSha', [put('.nax/context.md', 'x', 'A'.repeat(40))], 'baseSha'],
    ['a file over 256 KiB (UTF-8 bytes)', [put('.nax/context.md', 'é'.repeat(131_073))], 'size'],
    ['over 1 MiB in total', Array.from({ length: 5 }, (_, i) => put(`.nax/rules/r${i}.md`, 'x'.repeat(220_000))), 'size'],
    ['a NUL in content', [put('.nax/context.md', 'a\u0000b')], 'content'],
    ['a non-object entry', ['x'], 'edit'],
  ])('refuses %s', (_label, raw, fragment) => {
    expect(reasonOf(() => validateConfigEdits(raw))).toContain(fragment);
  });

  it('accepts an empty string as put content (emptying a rule file)', () => {
    expect(validateConfigEdits([put('.nax/rules/a.md', '', SHA)])).toEqual([{ path: '.nax/rules/a.md', op: 'put', content: '', baseSha: SHA }]);
  });
});

describe('validatePrTitle / validatePrBody / validateBaseSha', () => {
  it('trims and bounds the title', () => {
    expect(validatePrTitle('  Tighten rules  ')).toBe('Tighten rules');
    expect(validatePrTitle('t'.repeat(200))).toHaveLength(200);
    for (const bad of ['', '   ', 't'.repeat(201), 'a\nb', 42, undefined]) expect(() => validatePrTitle(bad)).toThrow(ValidationAppException);
  });

  it('bounds the body and maps absent to null', () => {
    expect(validatePrBody(undefined)).toBeNull();
    expect(validatePrBody(null)).toBeNull();
    expect(validatePrBody('why')).toBe('why');
    expect(() => validatePrBody('x'.repeat(8_193))).toThrow(ValidationAppException);
    expect(() => validatePrBody(5)).toThrow(ValidationAppException);
  });

  it('accepts a sha1 or sha256 commit id only', () => {
    expect(validateBaseSha(SHA)).toBe(SHA);
    expect(validateBaseSha('b'.repeat(64))).toBe('b'.repeat(64));
    for (const bad of ['abc', 'g'.repeat(40), 'a'.repeat(41), null]) expect(() => validateBaseSha(bad)).toThrow(ValidationAppException);
  });
});
