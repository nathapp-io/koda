import { ValidationAppException } from '@nathapp/nestjs-common';
import { ruleOverrideSha256, validateRuleOverride } from './rule-override';

function reason(fn: () => unknown): string {
  try { fn(); } catch (error) {
    expect(error).toBeInstanceOf(ValidationAppException);
    expect(error).toMatchObject({ httpStatus: 400, prefix: 'fleet.ruleOverride' });
    return (error as ValidationAppException).args?.reason as string;
  }
  throw new Error('expected validation refusal');
}

describe('rule override validation', () => {
  it('AC-1 defaults rulesMode and context', () => {
    expect(validateRuleOverride({ rules: [{ path: 'api.md', content: 'x' }] })).toEqual({ rules: [{ path: 'api.md', content: 'x' }], rulesMode: 'merge', context: null });
  });
  it('AC-2 defaults context mode', () => {
    expect(validateRuleOverride({ rules: [], context: { content: 'c' } }).context).toEqual({ content: 'c', mode: 'append' });
  });
  it.each([['AC-3 traversal path', '../x.md', 'path'], ['AC-4 extension', 'a.txt', 'path'], ['AC-5 uppercase path', 'API.md', 'path']])('%s refuses an invalid path', (_ac, path, expected) => {
    expect(reason(() => validateRuleOverride({ rules: [{ path, content: 'x' }] }))).toBe(expected);
  });
  it('AC-6 refuses duplicate paths', () => {
    expect(reason(() => validateRuleOverride({ rules: [{ path: 'a.md', content: 'x' }, { path: 'a.md', content: 'y' }] }))).toBe('duplicatePath');
  });
  it('AC-7 refuses more than 50 files', () => {
    const rules = Array.from({ length: 51 }, (_, i) => ({ path: `r${i}.md`, content: 'x' }));
    expect(reason(() => validateRuleOverride({ rules }))).toBe('rules');
  });
  it('AC-8 refuses content over the per-file UTF-8 byte limit', () => {
    expect(reason(() => validateRuleOverride({ rules: [{ path: 'a.md', content: 'é'.repeat(16_385) + 'a' }] }))).toBe('content');
  });
  it('AC-9 refuses NUL in rule content', () => {
    expect(reason(() => validateRuleOverride({ rules: [{ path: 'a.md', content: 'x\0y' }] }))).toBe('content');
  });
  it('AC-10 refuses aggregate rule content over the limit', () => {
    const rules = Array.from({ length: 9 }, (_, i) => ({ path: `r${i}.md`, content: 'x'.repeat(30_000) }));
    expect(reason(() => validateRuleOverride({ rules }))).toBe('size');
  });
  it('AC-11 refuses invalid rulesMode', () => {
    expect(reason(() => validateRuleOverride({ rules: [{ path: 'a.md', content: 'x' }], rulesMode: 'append' }))).toBe('rulesMode');
  });
  it('AC-12 refuses invalid context mode', () => {
    expect(reason(() => validateRuleOverride({ rules: [], context: { content: 'c', mode: 'merge' } }))).toBe('contextMode');
  });
  it('AC-13 refuses an empty override', () => {
    expect(reason(() => validateRuleOverride({ rules: [] }))).toBe('empty');
  });
});

describe('ruleOverrideSha256', () => {
  const a = { path: 'a.md', content: 'alpha' };
  const b = { path: 'b.md', content: 'beta' };
  const input = (rules: Array<{ path: string; content: string }>) => ({ rules, rulesMode: 'merge' as const, context: null });
  it('AC-14 hashes sorted rules as a stable lowercase SHA-256', () => {
    const first = ruleOverrideSha256(input([a, b]));
    expect(ruleOverrideSha256(input([b, a]))).toBe(first);
    expect(first).toMatch(/^[0-9a-f]{64}$/);
  });
  it("AC-15 changes when a rule's content changes", () => {
    expect(ruleOverrideSha256(input([a]))).not.toBe(ruleOverrideSha256(input([{ ...a, content: 'changed' }])));
  });
});
