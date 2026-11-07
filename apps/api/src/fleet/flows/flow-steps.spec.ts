import { describe, expect, it } from 'vitest';
import { AGENT_TASK_MAX_LENGTH } from '../common/agent-jobs';
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
      `/spec-review --spec .nax/features/a/spec.md --prd .nax/features/a/prd.json --phase 9\n\n${FLOW_VERDICT_INSTRUCTION}`,
    );
  });

  it('keeps oversized PRD review tasks within the AGENT task bound', () => {
    const task = buildReviewTask('PRD_REVIEW', 'p'.repeat(20_000), 'a');
    expect(task.length).toBeLessThanOrEqual(AGENT_TASK_MAX_LENGTH);
  });

  it('preserves the complete verdict suffix when truncating an oversized PRD review task', () => {
    const task = buildReviewTask('PRD_REVIEW', 'p'.repeat(20_000), 'a');
    expect(task.endsWith(`\n\n${FLOW_VERDICT_INSTRUCTION}`)).toBe(true);
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
