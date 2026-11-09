import { describe, expect, it } from 'vitest';
import { AGENT_TASK_MAX_LENGTH } from '../common/agent-jobs';
import {
  buildReviewTask,
  FLOW_CALLS_PRECEDENCE,
  FLOW_STOP_DETAIL_MAX,
  FLOW_VERDICT_INSTRUCTION,
  FLOW_PRD_EDITS_INSTRUCTION,
} from './flow-steps';

describe('flow steps', () => {
  it('builds a SPEC_REVIEW task with the verdict instruction', () => {
    expect(buildReviewTask('SPEC_REVIEW', '.nax/features/a/spec.md', 'a')).toBe(
      `/spec-review .nax/features/a/spec.md\n\n${FLOW_CALLS_PRECEDENCE}\n\n${FLOW_VERDICT_INSTRUCTION}`,
    );
  });

  it('US-007 AC-3: a set review names every spec path of the set', () => {
    const task = buildReviewTask('SPEC_REVIEW', '.nax/features/a/spec.md', 'a', {
      setSpecPaths: ['.nax/features/a/spec.md', '.nax/features/b/spec.md'],
    });
    expect(task.startsWith('/spec-review .nax/features/a/spec.md')).toBe(true);
    expect(task).toContain('.nax/features/b/spec.md');
  });

  it('US-007 AC-4: a set review asks for cross-spec consistency and names the feature on every finding', () => {
    const task = buildReviewTask('SPEC_REVIEW', '.nax/features/a/spec.md', 'a', {
      setSpecPaths: ['.nax/features/a/spec.md', '.nax/features/b/spec.md'],
    });
    expect(task).toContain('cross-spec consistency');
    expect(task).toContain('"feature":"<feature>"');
    // The features of the set are named, so a finding can be routed to one of them.
    expect(task).toContain('a, b');
  });

  it('US-007 AC-5: a single-spec review keeps its exact previous task', () => {
    const task = buildReviewTask('SPEC_REVIEW', '.nax/features/a/spec.md', 'a');
    expect(task).toBe(
      `/spec-review .nax/features/a/spec.md\n\n${FLOW_CALLS_PRECEDENCE}\n\n${FLOW_VERDICT_INSTRUCTION}`,
    );
    expect(task).not.toContain('cross-spec');
    expect(task).not.toContain('"feature":"<feature>"');
  });

  it('US-007 AC-6: an oversized set review keeps the verdict instruction whole', () => {
    const setSpecPaths = Array.from({ length: 40 }, (_, index) => `.nax/features/f${index}/${'p'.repeat(500)}/spec.md`);
    const task = buildReviewTask('SPEC_REVIEW', setSpecPaths[0], 'f0', { setSpecPaths });
    expect(task.length).toBeLessThanOrEqual(AGENT_TASK_MAX_LENGTH);
    // The set prompt filled the whole budget, so the task really was cut.
    expect(task.length).toBe(AGENT_TASK_MAX_LENGTH);
    expect(task.startsWith('/spec-review ')).toBe(true);
    expect(task.endsWith(`\n\n${FLOW_CALLS_PRECEDENCE}\n\n${FLOW_VERDICT_INSTRUCTION}`)).toBe(true);
  });

  it('builds a PRD_REVIEW task with both spec and PRD paths', () => {
    expect(buildReviewTask('PRD_REVIEW', '.nax/features/a/spec.md', 'a')).toBe(
      `/spec-review --spec .nax/features/a/spec.md --prd .nax/features/a/prd.json --phase 9\n\n${FLOW_CALLS_PRECEDENCE}\n\n${FLOW_VERDICT_INSTRUCTION}`,
    );
  });

  it('adds PRD edit instructions only for opted-in PRD review', () => {
    const task = buildReviewTask('PRD_REVIEW', '.nax/features/a/spec.md', 'a', { prdEdits: true });
    expect(task.endsWith(`${FLOW_VERDICT_INSTRUCTION}\n\n${FLOW_PRD_EDITS_INSTRUCTION}`)).toBe(true);
    expect(buildReviewTask('SPEC_REVIEW', '.nax/features/a/spec.md', 'a', { prdEdits: true }))
      .toBe(buildReviewTask('SPEC_REVIEW', '.nax/features/a/spec.md', 'a'));
    expect(buildReviewTask('PRD_REVIEW', '.nax/features/a/spec.md', 'a', { prdEdits: false }))
      .toBe(buildReviewTask('PRD_REVIEW', '.nax/features/a/spec.md', 'a'));
    for (const op of ['replace_description', 'replace_ac', 'remove_ac', 'add_ac', 'add_context_file', 'remove_context_file']) {
      expect(FLOW_PRD_EDITS_INSTRUCTION).toContain(op);
    }
    expect(FLOW_PRD_EDITS_INSTRUCTION).toContain('Do not edit any file: the flow commits your edits.');
    expect(FLOW_PRD_EDITS_INSTRUCTION).toContain('the object must still start with {"findings"');
  });

  it('keeps oversized PRD review tasks within the AGENT task bound', () => {
    const task = buildReviewTask('PRD_REVIEW', 'p'.repeat(20_000), 'a');
    expect(task.length).toBeLessThanOrEqual(AGENT_TASK_MAX_LENGTH);
  });

  it('preserves the complete verdict suffix when truncating an oversized PRD review task', () => {
    const task = buildReviewTask('PRD_REVIEW', 'p'.repeat(20_000), 'a');
    expect(task.endsWith(`\n\n${FLOW_CALLS_PRECEDENCE}\n\n${FLOW_VERDICT_INSTRUCTION}`)).toBe(true);
  });

  it('tells the reviewer that the Flow\'s calls section amends the spec body above it', () => {
    expect(FLOW_CALLS_PRECEDENCE).toContain("## Flow's calls");
    expect(FLOW_CALLS_PRECEDENCE).toContain('amends the spec text above it');
    expect(FLOW_CALLS_PRECEDENCE).toContain('not been edited to match');
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
