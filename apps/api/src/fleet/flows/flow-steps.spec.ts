import { describe, expect, it } from 'vitest';
import {
  buildReviewTask,
  FLOW_STOP_DETAIL_MAX,
  FLOW_VERDICT_INSTRUCTION,
} from './flow-steps';

describe('flow steps', () => {
  it('builds a SPEC_REVIEW task with the verdict instruction', () => {
    expect(buildReviewTask('SPEC_REVIEW', '.nax/features/a/spec.md', 'a')).toBe(
      `/spec-review .nax/features/a/spec.md\n\n${FLOW_VERDICT_INSTRUCTION}`,
    );
  });

  it('builds a PRD_REVIEW task with both spec and PRD paths', () => {
    expect(buildReviewTask('PRD_REVIEW', '.nax/features/a/spec.md', 'a')).toBe(
      `/spec-review --spec .nax/features/a/spec.md --prd .nax/features/a/prd.json\n\n${FLOW_VERDICT_INSTRUCTION}`,
    );
  });

  it('keeps review tasks within the AGENT task bound for a 400-character spec path', () => {
    expect(buildReviewTask('SPEC_REVIEW', 'p'.repeat(400), 'a').length).toBeLessThanOrEqual(16_384);
  });

  it('includes the classified schema and ends with the exact empty-findings line', () => {
    expect(FLOW_VERDICT_INSTRUCTION).toContain('"class":"answered|minor|ambiguous"');
    expect(FLOW_VERDICT_INSTRUCTION.split('\n')).toContain('{"findings":[]}');
    expect(FLOW_VERDICT_INSTRUCTION.endsWith('{"findings":[]}')).toBe(true);
  });

  it('sets the maximum flow stop detail length to 2000', () => {
    expect(FLOW_STOP_DETAIL_MAX).toBe(2000);
  });

  it('does not add PRD-only flags to SPEC_REVIEW tasks', () => {
    const task = buildReviewTask('SPEC_REVIEW', '.nax/features/a/spec.md', 'a');
    expect(task).not.toContain('--spec');
    expect(task).not.toContain('--prd');
  });
});
