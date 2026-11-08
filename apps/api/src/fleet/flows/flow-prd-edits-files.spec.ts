import { describe, expect, it } from 'vitest';
import type { FlowPrdEdit } from './flow-prd-edits';
import { applyPrdEditsToText } from './flow-prd-edits';

type Prd = { analysis?: unknown; branchName?: unknown; userStories: Array<Record<string, unknown>> };
const story = (fields: Record<string, unknown> = {}) => ({ id: 'US-001', acceptanceCriteria: ['one', 'two'], ...fields });
function apply(prd: Prd, edits: FlowPrdEdit[]) {
  return applyPrdEditsToText(JSON.stringify(prd), edits);
}
function parsed(result: ReturnType<typeof applyPrdEditsToText>): Prd {
  expect(result.kind).toBe('ok');
  if (result.kind !== 'ok') throw new Error('Expected readable PRD');
  return JSON.parse(result.text) as Prd;
}
const addFile = (path: string): FlowPrdEdit => ({ story: 'US-001', op: 'add_context_file', path });

describe('applyPrdEditsToText context files and output', () => {
  it('AC-1 and AC-12: appends a context file, creating the array and preserving existing paths', () => {
    expect(parsed(apply({ userStories: [story()] }, [addFile('src/a.ts')])).userStories[0]?.contextFiles).toEqual(['src/a.ts']);
    expect(parsed(apply({ userStories: [story({ contextFiles: ['src/existing.ts'] })] }, [addFile('src/a.ts')])).userStories[0]?.contextFiles).toEqual(['src/existing.ts', 'src/a.ts']);
  });
  it('AC-2: refuses an unsafe context-file path', () => {
    expect(apply({ userStories: [story()] }, [addFile('../secrets')])).toMatchObject({ kind: 'ok', refused: [{ index: 0, reason: 'invalid path' }] });
  });
  it('AC-3: refuses a duplicate context-file path', () => {
    expect(apply({ userStories: [story({ contextFiles: ['src/a.ts'] })] }, [addFile('src/a.ts')])).toMatchObject({ kind: 'ok', refused: [{ reason: 'duplicate path' }] });
  });
  it('AC-4: removes a listed context file', () => {
    const result = apply({ userStories: [story({ contextFiles: ['src/a.ts', 'src/b.ts'] })] }, [{ story: 'US-001', op: 'remove_context_file', path: 'src/a.ts' }]);
    expect(parsed(result).userStories[0]?.contextFiles).toEqual(['src/b.ts']);
  });
  it('AC-5: refuses removal of an unlisted context file', () => {
    expect(apply({ userStories: [story({ contextFiles: ['src/b.ts'] })] }, [{ story: 'US-001', op: 'remove_context_file', path: 'src/a.ts' }])).toMatchObject({ kind: 'ok', refused: [{ reason: 'path not listed' }] });
  });
  it('AC-6: refuses edit 13 at the edit limit', () => {
    const edits: FlowPrdEdit[] = Array.from({ length: 13 }, (_, i) => ({ story: 'US-001', op: 'add_ac', new: `criterion ${i}` }));
    expect(apply({ userStories: [story()] }, edits)).toMatchObject({ kind: 'ok', refused: [{ index: 12, reason: 'over limit' }] });
  });
  it('AC-7: refuses text longer than the edit text cap', () => {
    expect(apply({ userStories: [story()] }, [{ story: 'US-001', op: 'add_ac', new: 'x'.repeat(401) }])).toMatchObject({ kind: 'ok', refused: [{ reason: 'text too long' }] });
  });
  it('AC-8 and AC-9: reports invalid JSON and missing userStories as unreadable', () => {
    expect(applyPrdEditsToText('not-json', [])).toEqual({ kind: 'unreadable' });
    expect(applyPrdEditsToText('{"analysis":{}}', [])).toEqual({ kind: 'unreadable' });
  });
  it('AC-10: preserves untouched document and story keys', () => {
    const prd = { analysis: { note: 'keep' }, branchName: 'branch', userStories: [story({ dependencies: ['US-000'] })] };
    const result = parsed(apply(prd, [addFile('src/a.ts')]));
    expect(result.analysis).toEqual(prd.analysis);
    expect(result.branchName).toBe('branch');
    expect(result.userStories[0]?.dependencies).toEqual(['US-000']);
  });
  it('AC-11: returns stable pretty JSON with a final newline', () => {
    const edited = { analysis: 'kept', userStories: [story({ contextFiles: ['src/a.ts'] })] };
    const result = apply({ analysis: 'kept', userStories: [story()] }, [addFile('src/a.ts')]);
    expect(result).toMatchObject({ kind: 'ok', text: `${JSON.stringify(edited, null, 2)}\n` });
  });
});
