import { outcomeNote } from './outcome-note';
import type { PendingActionRecord } from './pending-action.domain';

const action = (over: Partial<Pick<PendingActionRecord, 'id' | 'tool' | 'status' | 'result'>>) =>
  ({ id: 'act1', tool: 'koda_add_comment', status: 'EXECUTED' as const, result: 'ok', ...over });

describe('outcomeNote (2a-D9)', () => {
  it('EXECUTED names the action, the tool and the result', () => {
    expect(outcomeNote(action({ status: 'EXECUTED', result: 'comment added' })))
      .toBe('Action act1 (koda_add_comment) was approved and done: comment added');
  });

  it('FAILED names the action, the tool and the result', () => {
    expect(outcomeNote(action({ status: 'FAILED', result: 'not_found' })))
      .toBe('Action act1 (koda_add_comment) was approved but failed: not_found');
  });

  it('REJECTED says the user rejected it', () => {
    expect(outcomeNote(action({ status: 'REJECTED', result: null }))).toBe('Action act1 (koda_add_comment) was rejected by the user.');
  });

  it('EXPIRED says it expired without a decision', () => {
    expect(outcomeNote(action({ status: 'EXPIRED', result: null }))).toBe('Action act1 (koda_add_comment) expired without a decision.');
  });

  it('AC-18: a 600 character result is capped to its first 500 characters and an ellipsis', () => {
    const result = 'a'.repeat(250) + 'b'.repeat(250) + 'c'.repeat(100);
    const note = outcomeNote(action({ status: 'EXECUTED', result }));
    expect(note).toBe(`Action act1 (koda_add_comment) was approved and done: ${result.slice(0, 500)}…`);
    expect(note).not.toContain('c'.repeat(100));
  });

  it('a result of exactly 500 characters is kept whole, without an ellipsis', () => {
    const result = 'x'.repeat(500);
    expect(outcomeNote(action({ status: 'FAILED', result }))).toBe(`Action act1 (koda_add_comment) was approved but failed: ${result}`);
  });

  it('a null result on an executed action reads as empty', () => {
    expect(outcomeNote(action({ status: 'EXECUTED', result: null }))).toBe('Action act1 (koda_add_comment) was approved and done: ');
  });

  it('refuses a status that has no outcome note', () => {
    expect(() => outcomeNote(action({ status: 'PENDING' }))).toThrow();
  });
});
