import { describe, expect, test } from 'bun:test';
import { THREAD_DOC_LIMITS, isAllowedThreadDocPath } from '@nathapp/fleet-protocol';

describe('isAllowedThreadDocPath (US-001)', () => {
  test('US-001 AC-1: docs/specs/divide.md is allowed', () => {
    expect(isAllowedThreadDocPath('docs/specs/divide.md', 'divide')).toBe(true);
  });

  test('US-001 AC-2: .nax/features/<feature>/spec.md is allowed for the thread feature', () => {
    expect(isAllowedThreadDocPath('.nax/features/divide/spec.md', 'divide')).toBe(true);
  });

  test('US-001 AC-3: .nax/features/<other>/spec.md is refused for another feature', () => {
    expect(isAllowedThreadDocPath('.nax/features/other/spec.md', 'divide')).toBe(false);
  });

  test('US-001 AC-4: a dot-dot segment is refused', () => {
    expect(isAllowedThreadDocPath('docs/../src/a.md', 'divide')).toBe(false);
  });

  test('US-001 AC-5: a leading slash is refused', () => {
    expect(isAllowedThreadDocPath('/docs/a.md', 'divide')).toBe(false);
  });

  test('US-001 AC-6: a .git segment is refused in any letter case', () => {
    expect(isAllowedThreadDocPath('docs/.GIT/a.md', 'divide')).toBe(false);
  });

  test('US-001 AC-7: a non-markdown file is refused', () => {
    expect(isAllowedThreadDocPath('docs/a.ts', 'divide')).toBe(false);
  });

  test('US-001 AC-8: a docs directory below another root is refused', () => {
    expect(isAllowedThreadDocPath('src/docs/a.md', 'divide')).toBe(false);
  });

  test('US-001 AC-9: a 513-character docs/ .md path is refused (maxPathChars is 512)', () => {
    expect(THREAD_DOC_LIMITS.maxPathChars).toBe(512);
    const path = `docs/${'a'.repeat(513 - 'docs/'.length - '.md'.length)}.md`;
    expect(path.length).toBe(513);
    expect(isAllowedThreadDocPath(path, 'divide')).toBe(false);
  });

  test('US-001: a 512-character docs/ .md path is allowed (the cap is inclusive)', () => {
    const path = `docs/${'a'.repeat(512 - 'docs/'.length - '.md'.length)}.md`;
    expect(path.length).toBe(512);
    expect(isAllowedThreadDocPath(path, 'divide')).toBe(true);
  });

  test('US-001: rejects an empty path, a backslash, a NUL and a non-md suffix', () => {
    expect(isAllowedThreadDocPath('', 'divide')).toBe(false);
    expect(isAllowedThreadDocPath('docs\\a.md', 'divide')).toBe(false);
    expect(isAllowedThreadDocPath('docs/a\u0000.md', 'divide')).toBe(false);
    expect(isAllowedThreadDocPath('docs/.md', 'divide')).toBe(false);
    expect(isAllowedThreadDocPath('docs/a.md.txt', 'divide')).toBe(false);
  });

  test('US-001: rejects a docs path with a single segment and a .nax path with fewer than four segments', () => {
    expect(isAllowedThreadDocPath('docs.md', 'divide')).toBe(false);
    expect(isAllowedThreadDocPath('.nax/features/divide.md', 'divide')).toBe(false);
  });

  test('US-001: rejects a segment with a space or a shell character', () => {
    expect(isAllowedThreadDocPath('docs/a b.md', 'divide')).toBe(false);
    expect(isAllowedThreadDocPath('docs/a*.md', 'divide')).toBe(false);
  });
});
