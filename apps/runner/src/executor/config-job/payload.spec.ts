import { describe, expect, test } from 'bun:test';
import { NAX_CONFIG_LIMITS } from '@nathapp/fleet-protocol';
import { parseConfigEditPayload } from './payload';

const SHA = 'a'.repeat(40);
const BLOB = 'b'.repeat(40);
const edit = (over: Record<string, unknown> = {}) => ({ path: '.nax/rules/style.md', op: 'put', content: '# style\n', baseSha: BLOB, ...over });
const payload = (over: Record<string, unknown> = {}) => ({ mode: 'edit', edits: [edit()], prTitle: 'Tighten rules', prBody: null, baseSha: SHA, ...over });

describe('parseConfigEditPayload (D30)', () => {
  test('returns a clean copy of a well-formed edit, regenerate and drift payload', () => {
    expect(parseConfigEditPayload({ ...payload(), extra: 1 }, 'CONFIG_EDIT')).toEqual(payload() as never);
    const regenerate = payload({ mode: 'regenerate', edits: [] });
    expect(parseConfigEditPayload(regenerate, 'CONFIG_EDIT')).toEqual(regenerate as never);
    const drift = payload({ mode: 'drift', edits: [], prTitle: null });
    expect(parseConfigEditPayload(drift, 'CONFIG_DRIFT')).toEqual(drift as never);
  });
  test('accepts a new file (baseSha null) and a delete (no content)', () => {
    const p = payload({ edits: [edit({ path: '.nax/rules/new.md', baseSha: null }), { path: '.nax/constitution.md', op: 'delete', baseSha: BLOB }] });
    expect(parseConfigEditPayload(p, 'CONFIG_EDIT')).toEqual(p as never);
  });
  test.each([
    ['not an object', 'x', 'CONFIG_EDIT'],
    ['a drift mode on CONFIG_EDIT', payload({ mode: 'drift', edits: [], prTitle: null }), 'CONFIG_EDIT'],
    ['an edit mode on CONFIG_DRIFT', payload(), 'CONFIG_DRIFT'],
    ['an empty edit list in edit mode', payload({ edits: [] }), 'CONFIG_EDIT'],
    ['edits in regenerate mode', payload({ mode: 'regenerate' }), 'CONFIG_EDIT'],
    ['a bad commit sha', payload({ baseSha: 'xyz' }), 'CONFIG_EDIT'],
    ['an .env profile', payload({ edits: [edit({ path: '.nax/profiles/prod.env' })] }), 'CONFIG_EDIT'],
    ['a path outside the allowlist', payload({ edits: [edit({ path: 'src/index.ts' })] }), 'CONFIG_EDIT'],
    ['a traversal', payload({ edits: [edit({ path: '.nax/rules/../../x.md' })] }), 'CONFIG_EDIT'],
    ['a duplicate path', payload({ edits: [edit(), edit()] }), 'CONFIG_EDIT'],
    ['an unknown op', payload({ edits: [edit({ op: 'chmod' })] }), 'CONFIG_EDIT'],
    ['a put without content', payload({ edits: [edit({ content: undefined })] }), 'CONFIG_EDIT'],
    ['a delete with content', payload({ edits: [{ path: '.nax/context.md', op: 'delete', content: 'x', baseSha: BLOB }] }), 'CONFIG_EDIT'],
    ['a NUL in content', payload({ edits: [edit({ content: 'a\0b' })] }), 'CONFIG_EDIT'],
    ['a bad blob sha', payload({ edits: [edit({ baseSha: 'nope' })] }), 'CONFIG_EDIT'],
    ['a file over the size limit', payload({ edits: [edit({ content: 'x'.repeat(NAX_CONFIG_LIMITS.maxFileBytes + 1) })] }), 'CONFIG_EDIT'],
    ['too many edits', payload({ edits: Array.from({ length: NAX_CONFIG_LIMITS.maxEdits + 1 }, (_, i) => edit({ path: `.nax/rules/r${i}.md` })) }), 'CONFIG_EDIT'],
    ['a missing PR title', payload({ prTitle: '' }), 'CONFIG_EDIT'],
    ['a PR title with a newline', payload({ prTitle: 'a\nb' }), 'CONFIG_EDIT'],
    ['a PR title on a drift', payload({ mode: 'drift', edits: [], prTitle: 'x' }), 'CONFIG_DRIFT'],
    ['a PR body over the limit', payload({ prBody: 'x'.repeat(NAX_CONFIG_LIMITS.maxPrBodyBytes + 1) }), 'CONFIG_EDIT'],
  ] as const)('rejects %s', (_label, raw, command) => {
    expect(parseConfigEditPayload(raw, command)).toBeNull();
  });
  test('rejects a total over the limit even when each file fits', () => {
    const per = Math.floor(NAX_CONFIG_LIMITS.maxFileBytes * 0.9);
    const count = Math.ceil(NAX_CONFIG_LIMITS.maxTotalBytes / per) + 1;
    const edits = Array.from({ length: Math.min(count, NAX_CONFIG_LIMITS.maxEdits) }, (_, i) => edit({ path: `.nax/rules/r${i}.md`, content: 'x'.repeat(per) }));
    expect(parseConfigEditPayload(payload({ edits }), 'CONFIG_EDIT')).toBeNull();
  });
});
