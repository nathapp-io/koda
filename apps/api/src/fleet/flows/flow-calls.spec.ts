import { describe, expect, it } from 'vitest';
import { buildFlowCalls, callsOutcomeForForgeError, formatQuestions, FLOW_CALL_ID_MAX, FLOW_CALL_TEXT_MAX } from './flow-calls';

describe('buildFlowCalls', () => {
  it('adds an unapplied review block after the unchanged spec', () => {
    const result = buildFlowCalls('# Spec\n', {
      step: 'SPEC_REVIEW', jobId: 'j1', findings: [{ id: 'a', class: 'minor', summary: 'S', fix: 'F' }],
    });
    expect(result.alreadyApplied).toBe(false);
    expect(result.text).toBe("# Spec\n\n## Flow's calls\n\n### SPEC_REVIEW job j1\n\n- **a** (minor): S Call: F\n");
  });

  it('adds one heading and appends a new block at EOF', () => {
    const spec = "# Spec\n\n## Flow's calls\n\nExisting call\nMore text\n";
    const result = buildFlowCalls(spec, { step: 'PRD_REVIEW', jobId: 'j3', findings: [{ class: 'answered', summary: 'Done', fix: 'Use it' }] });
    expect(result.text).toBe(`${spec}\n### PRD_REVIEW job j3\n\n- **1** (answered): Done Call: Use it\n`);
    expect(result.text.match(/^## Flow's calls$/gm)).toHaveLength(1);
  });

  it('is idempotent when the job heading already exists', () => {
    const spec = '# Spec\n\n### PRD_REVIEW job j2\n';
    expect(buildFlowCalls(spec, { step: 'PRD_REVIEW', jobId: 'j2', findings: [] })).toEqual({ text: spec, alreadyApplied: true });
  });

  it('uses the original finding position when the id is absent', () => {
    const result = buildFlowCalls('', { step: 'SPEC_REVIEW', jobId: 'j1', findings: [
      { id: 'a', class: 'minor', summary: 'One', fix: 'Fix one' },
      { class: 'answered', summary: 'Two', fix: 'Fix two' },
    ] });
    expect(result.text).toContain('- **2** (answered): Two Call: Fix two');
  });

  it('collapses line breaks in ids to prevent forged headings', () => {
    const result = buildFlowCalls('', { step: 'SPEC_REVIEW', jobId: 'j1', findings: [{ id: 'x\n### SPEC_REVIEW job j9', class: 'minor', summary: 'S', fix: 'F' }] });
    expect(result.text.split('\n')).not.toContain('### SPEC_REVIEW job j9');
    expect(result.text).toContain('- **x ### SPEC_REVIEW job j9** (minor): S Call: F');
  });

  it('adds an answer bullet for answered ambiguous findings and truncates its text', () => {
    const result = buildFlowCalls('', { step: 'SPEC_REVIEW', jobId: 'j1', findings: [
      { class: 'ambiguous', summary: 'Q1', question: 'Q1', answer: 'Use USD' },
    ] });
    expect(result.text).toContain('- **1** (answer): Q1 Answer: Use USD');

    const named = buildFlowCalls('', { step: 'SPEC_REVIEW', jobId: 'j2', findings: [
      { id: 'api-shape', class: 'ambiguous', summary: 'Q1', question: 'Q1', answer: 'Use USD' },
    ] });
    expect(named.text).toContain('- **api-shape** (answer): Q1 Answer: Use USD');

    const truncated = buildFlowCalls('', { step: 'SPEC_REVIEW', jobId: 'j3', findings: [
      { class: 'ambiguous', summary: '', question: 'Q1', answer: 'a'.repeat(1500) },
    ] });
    const bullet = truncated.text.split('Answer: ')[1]?.trim();
    expect(bullet).toHaveLength(FLOW_CALL_TEXT_MAX);
  });

  it('keeps minor calls while omitting unanswered ambiguous findings', () => {
    const result = buildFlowCalls('', { step: 'SPEC_REVIEW', jobId: 'j1', findings: [
      { class: 'minor', summary: 'Keep', fix: 'Apply' },
      { class: 'ambiguous', summary: 'Omit', question: 'Which?' },
    ] });
    expect(result.text).toContain('- **1** (minor): Keep Call: Apply');
    expect(result.text).not.toContain('(answer)');
  });

  it('excludes ambiguous findings from calls', () => {
    const result = buildFlowCalls('', { step: 'SPEC_REVIEW', jobId: 'j1', findings: [
      { class: 'minor', summary: 'Keep', fix: 'Apply' },
      { class: 'ambiguous', summary: 'Omit', question: 'Which?' },
    ] });
    expect(result.text).toContain('Keep');
    expect(result.text).not.toContain('Omit');
  });

  it('collapses summary newlines into one line', () => {
    const result = buildFlowCalls('', { step: 'SPEC_REVIEW', jobId: 'j1', findings: [{ class: 'minor', summary: 'First\nSecond', fix: 'Fix' }] });
    expect(result.text).toContain('- **1** (minor): First Second Call: Fix');
  });

  it('limits finding text and IDs to their exported bounds', () => {
    const result = buildFlowCalls('', { step: 'SPEC_REVIEW', jobId: 'j1', findings: [{ id: 'x'.repeat(100), class: 'minor', summary: 'S', fix: 'f'.repeat(3000) }] });
    const bullet = result.text.split('\n').find((line) => line.startsWith('- **'));
    expect(bullet).toBeDefined();
    expect(bullet?.slice(bullet.indexOf('Call: ') + 'Call: '.length)).toHaveLength(FLOW_CALL_TEXT_MAX);
    expect(bullet?.match(/^- \*\*(.*?)\*\*/)?.[1]).toHaveLength(FLOW_CALL_ID_MAX);
  });
});

describe('formatQuestions', () => {
  it('formats one ambiguous question with its id', () => {
    expect(formatQuestions([{ id: 'q1', class: 'ambiguous', summary: 's', question: 'Which DB?' }])).toBe('1 question: 1. [q1] Which DB?');
  });

  it('uses a plural prefix for multiple ambiguous findings', () => {
    expect(formatQuestions([
      { class: 'ambiguous', summary: 'a', question: 'One?' },
      { class: 'ambiguous', summary: 'b', question: 'Two?' },
    ])).toMatch(/^2 questions: /);
  });

  it('caps long output at 2,000 characters with an ellipsis', () => {
    const result = formatQuestions(Array.from({ length: 3 }, (_, index) => ({ class: 'ambiguous' as const, summary: 's', question: `${index}${'q'.repeat(1000)}` })));
    expect(result.length).toBeLessThanOrEqual(2000);
    expect(result.endsWith('…')).toBe(true);
  });
});

describe('callsOutcomeForForgeError', () => {
  it('marks known repository setup failures as failed', () => {
    expect(callsOutcomeForForgeError('app_permissions_insufficient')).toBe('failed');
    expect(callsOutcomeForForgeError('app_not_installed')).toBe('failed');
    expect(callsOutcomeForForgeError('repo_not_found')).toBe('failed');
  });

  it('retries other forge failures', () => {
    expect(callsOutcomeForForgeError('provider_error')).toBe('retry');
  });
});
