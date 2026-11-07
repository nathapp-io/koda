import { ValidationAppException } from '@nathapp/nestjs-common';
import { describe, expect, it } from 'vitest';
import { parseFlowAnswers } from './flow-answers';

function failure(body: unknown): { error: unknown; reason: unknown; prefix: unknown } {
  try {
    parseFlowAnswers(body);
  } catch (error) {
    const validationError = error as ValidationAppException & { args: { reason: string } };
    return { error, reason: validationError.args.reason, prefix: validationError.prefix };
  }
  throw new Error('Expected validation failure');
}

describe('parseFlowAnswers', () => {
  it('AC-1 returns a stable answer input', () => {
    expect(parseFlowAnswers({ jobId: 'j1', answers: [{ id: '2', answer: 'A1' }] })).toEqual({ jobId: 'j1', answers: [{ id: '2', answer: 'A1' }] });
  });

  it('AC-2 rejects non-object bodies with the answers input exception', () => {
    for (const body of ['x', []]) {
      const result = failure(body);
      expect(result.error).toBeInstanceOf(ValidationAppException);
      expect(result.prefix).toBe('fleet.flows.answersInput');
      expect(result.reason).toBe('body');
    }
  });

  it('AC-3 requires a non-blank job id', () => {
    for (const jobId of [undefined, '', '  ']) expect(failure({ answers: [{ id: '2', answer: 'A' }], jobId }).reason).toBe('jobId');
  });

  it('AC-4 requires between one and twenty answers', () => {
    for (const answers of [undefined, [], Array.from({ length: 21 }, (_, i) => ({ id: String(i), answer: 'a' }))]) {
      expect(failure({ jobId: 'j1', answers }).reason).toBe('answers');
    }
  });

  it('AC-5 rejects non-object answer entries (arrays are not objects)', () => {
    for (const answer of ['x', []]) expect(failure({ jobId: 'j1', answers: [answer] }).reason).toBe('answers[0]');
  });

  it('AC-6 validates answer ids', () => {
    for (const id of [5, '  ', 'x'.repeat(65)]) expect(failure({ jobId: 'j1', answers: [{ id, answer: 'A' }] }).reason).toBe('answers[0].id');
  });

  it('AC-7 validates answer text', () => {
    for (const answer of [5, '  ', 'x'.repeat(1001)]) expect(failure({ jobId: 'j1', answers: [{ id: '2', answer }] }).reason).toBe('answers[0].answer');
  });

  it('AC-8 rejects duplicates on the second occurrence before validating later entries', () => {
    const duplicate = failure({ jobId: 'j1', answers: [{ id: '2', answer: 'a' }, { id: '2', answer: 'b' }] });
    expect(duplicate.reason).toBe('answers[1].id duplicate');
    expect(failure({ jobId: 'j1', answers: [{ id: '1', answer: 'a' }, { id: '1', answer: 'b' }, { id: 5 }] }).reason).toBe('answers[1].id duplicate');
  });

  it('AC-9 preserves answer whitespace', () => {
    expect(parseFlowAnswers({ jobId: 'j1', answers: [{ id: '2', answer: '  A1  ' }] }).answers[0].answer).toBe('  A1  ');
  });
});
