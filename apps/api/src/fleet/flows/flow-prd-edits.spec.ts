import { describe, expect, it } from 'vitest';
import { FLOW_PRD_EDIT_TEXT_MAX, FLOW_PRD_EDITS_MAX, parsePrdEdits } from './flow-prd-edits';

describe('parsePrdEdits', () => {
  it('parses a valid replacement criterion', () => {
    expect(parsePrdEdits([{ story: 'US-001', op: 'replace_ac', old: 'a', new: 'b' }]))
      .toEqual([{ story: 'US-001', op: 'replace_ac', old: 'a', new: 'b' }]);
  });
  it('rejects unknown operations', () => {
    expect(parsePrdEdits([{ story: 'US-001', op: 'rename_story' }])).toBeNull();
  });
  it('rejects empty required text', () => {
    expect(parsePrdEdits([{ story: 'US-001', op: 'remove_ac', old: '' }])).toBeNull();
    expect(parsePrdEdits([{ story: 'US-001', op: 'replace_ac', old: 'a', new: '' }])).toBeNull();
  });
  it('accepts an empty replacement description', () => {
    expect(parsePrdEdits([{ story: 'US-001', op: 'replace_description', old: 'a', new: '' }]))
      .toEqual([{ story: 'US-001', op: 'replace_description', old: 'a', new: '' }]);
  });
  it('rejects non-array input and malformed stories', () => {
    expect(parsePrdEdits({ story: 'US-001' })).toBeNull();
    expect(parsePrdEdits([{ story: 1, op: 'add_ac', new: 'criterion' }])).toBeNull();
  });
  it('preserves new text without truncation and sanitizes NUL', () => {
    const longText = 'x'.repeat(500);
    const result = parsePrdEdits([{ story: 'US-001', op: 'add_ac', new: longText }]);
    expect(result?.[0]).toEqual({ story: 'US-001', op: 'add_ac', new: longText });
    expect(result?.[0] && result[0].op === 'add_ac' ? result[0].new.length : 0).toBe(500);
    expect(parsePrdEdits([{ story: 'US-001', op: 'add_ac', new: 'a\u0000b' }]))
      .toEqual([{ story: 'US-001', op: 'add_ac', new: 'a\uFFFD' + 'b' }]);
  });
  it('rejects old text above its parser safety limit', () => {
    expect(parsePrdEdits([{ story: 'US-001', op: 'replace_ac', old: 'x'.repeat(FLOW_PRD_EDIT_TEXT_MAX * 4 + 1), new: 'y' }])).toBeNull();
  });
  it('exports the documented edit caps', () => {
    expect(FLOW_PRD_EDITS_MAX).toBe(12);
    expect(FLOW_PRD_EDIT_TEXT_MAX).toBe(400);
  });
});
