import { describe, expect, it } from 'vitest';
import type { FlowPrdEdit } from './flow-prd-edits';
import { applyPrdEditsToText } from './flow-prd-edits';

type Story = {
  id: string;
  description?: unknown;
  acceptanceCriteria?: unknown;
};

function apply(story: Story, edits: FlowPrdEdit[]) {
  return applyPrdEditsToText(JSON.stringify({ userStories: [story] }), edits);
}

function editedStory(result: ReturnType<typeof applyPrdEditsToText>): Record<string, unknown> {
  expect(result.kind).toBe('ok');
  if (result.kind !== 'ok') throw new Error('Expected a readable PRD');
  const story = (JSON.parse(result.text) as { userStories: Record<string, unknown>[] }).userStories[0];
  if (!story) throw new Error('Expected the edited story');
  return story;
}

describe('applyPrdEditsToText', () => {
  it('AC-1: replaces exactly one acceptance criterion', () => {
    const result = apply({ id: 'US-001', acceptanceCriteria: ['x', 'y'] }, [
      { story: 'US-001', op: 'replace_ac', old: 'y', new: 'z' },
    ]);
    expect(editedStory(result).acceptanceCriteria).toEqual(['x', 'z']);
  });

  it('AC-2: counts a changed edit as applied', () => {
    const result = apply({ id: 'US-001', acceptanceCriteria: ['x', 'y'] }, [
      { story: 'US-001', op: 'replace_ac', old: 'y', new: 'z' },
    ]);
    expect(result).toMatchObject({ kind: 'ok', applied: 1 });
  });

  it('AC-3: replaces one description occurrence and keeps surrounding text', () => {
    const result = apply({ id: 'US-001', description: 'before old after' }, [
      { story: 'US-001', op: 'replace_description', old: 'old', new: 'new' },
    ]);
    expect(editedStory(result).description).toBe('before new after');
  });

  it('AC-4: refuses non-unique description matches, including overlapping matches', () => {
    for (const description of ['old twice old', 'aaa']) {
      const old = description === 'aaa' ? 'aa' : 'old';
      const result = apply({ id: 'US-001', description }, [
        { story: 'US-001', op: 'replace_description', old, new: 'new' },
      ]);
      expect(result).toMatchObject({
        kind: 'ok',
        refused: [{ index: 0, story: 'US-001', op: 'replace_description', reason: 'text not unique' }],
      });
    }
  });

  it('AC-5: refuses a criterion that is not present', () => {
    const result = apply({ id: 'US-001', acceptanceCriteria: ['x'] }, [
      { story: 'US-001', op: 'replace_ac', old: 'missing', new: 'y' },
    ]);
    expect(result).toMatchObject({ kind: 'ok', refused: [{ reason: 'text not found' }] });
  });

  it('AC-6: refuses an edit for an unknown story', () => {
    const result = apply({ id: 'US-001', acceptanceCriteria: ['x'] }, [
      { story: 'US-404', op: 'add_ac', new: 'y' },
    ]);
    expect(result).toMatchObject({ kind: 'ok', refused: [{ story: 'US-404', reason: 'unknown story' }] });
  });

  it('AC-7: refuses criteria operations on a malformed acceptanceCriteria field', () => {
    const result = apply({ id: 'US-001', acceptanceCriteria: 'x' }, [
      { story: 'US-001', op: 'replace_ac', old: 'x', new: 'y' },
    ]);
    expect(result).toMatchObject({ kind: 'ok', refused: [{ reason: 'story malformed' }] });
  });

  it('AC-8: refuses a replacement that makes no change', () => {
    const result = apply({ id: 'US-001', acceptanceCriteria: ['x'] }, [
      { story: 'US-001', op: 'replace_ac', old: 'x', new: 'x' },
    ]);
    expect(result).toMatchObject({ kind: 'ok', refused: [{ reason: 'no change' }] });
  });

  it('AC-9: refuses a replacement that duplicates another criterion', () => {
    const result = apply({ id: 'US-001', acceptanceCriteria: ['x', 'y'] }, [
      { story: 'US-001', op: 'replace_ac', old: 'x', new: 'y' },
    ]);
    expect(result).toMatchObject({ kind: 'ok', refused: [{ reason: 'duplicate criterion' }] });
  });

  it('AC-10: removes the named criterion', () => {
    const result = apply({ id: 'US-001', acceptanceCriteria: ['x', 'y'] }, [
      { story: 'US-001', op: 'remove_ac', old: 'x' },
    ]);
    expect(editedStory(result).acceptanceCriteria).toEqual(['y']);
  });

  it('AC-11: refuses to remove the last criterion', () => {
    const result = apply({ id: 'US-001', acceptanceCriteria: ['x'] }, [
      { story: 'US-001', op: 'remove_ac', old: 'x' },
    ]);
    expect(result).toMatchObject({ kind: 'ok', refused: [{ reason: 'last criterion' }] });
  });

  it('AC-12: appends a new criterion', () => {
    const result = apply({ id: 'US-001', acceptanceCriteria: ['x'] }, [
      { story: 'US-001', op: 'add_ac', new: 'w' },
    ]);
    expect(editedStory(result).acceptanceCriteria).toEqual(['x', 'w']);
  });

  it('AC-13: refuses an already-listed criterion', () => {
    const result = apply({ id: 'US-001', acceptanceCriteria: ['x'] }, [
      { story: 'US-001', op: 'add_ac', new: 'x' },
    ]);
    expect(result).toMatchObject({ kind: 'ok', refused: [{ reason: 'duplicate criterion' }] });
  });

  it('AC-14: continues after a refusal and reports original edit indexes', () => {
    const result = apply({ id: 'US-001', acceptanceCriteria: ['x'] }, [
      { story: 'US-001', op: 'replace_ac', old: 'missing', new: 'y' },
      { story: 'US-001', op: 'add_ac', new: 'z' },
    ]);
    expect(result).toMatchObject({
      kind: 'ok',
      applied: 1,
      refused: [{ index: 0, reason: 'text not found' }],
    });
    expect(editedStory(result).acceptanceCriteria).toEqual(['x', 'z']);
  });
});
