import { requestOutcomeNote } from './request-outcome-note';

describe('requestOutcomeNote', () => {
  const base = { requestId: 'r1', tool: 'koda_add_comment' };
  it('AC-10: masks a missing target as not_found', () => {
    expect(requestOutcomeNote({ ...base, status: 'failed', result: { error: 'execution-failed', name: 'NotFoundAppException' } }))
      .toBe('Action r1 (koda_add_comment) was approved but failed: not_found');
  });
  it('AC-11: masks other failures instead of disclosing their details', () => {
    expect(requestOutcomeNote({ ...base, status: 'failed', result: { error: 'permission-revoked' } }))
      .toBe('Action r1 (koda_add_comment) was approved but failed: error: koda_add_comment failed');
  });
  it.each([
    ['rejected', 'was rejected.'],
    ['expired', 'expired without a decision.'],
    ['cancelled', 'was cancelled.'],
  ] as const)('AC-12: formats %s', (status, ending) => {
    expect(requestOutcomeNote({ ...base, status, result: null })).toBe(`Action r1 (koda_add_comment) ${ending}`);
  });
  it('AC-13: caps executed text at 500 characters plus ellipsis', () => {
    expect(requestOutcomeNote({ ...base, status: 'executed', result: { text: 'x'.repeat(600) } }))
      .toBe(`Action r1 (koda_add_comment) was approved and done: ${'x'.repeat(500)}…`);
  });
  it('keeps short executed text intact', () => {
    expect(requestOutcomeNote({ ...base, status: 'executed', result: { text: 'comment c1 added' } }))
      .toBe('Action r1 (koda_add_comment) was approved and done: comment c1 added');
  });
  it.each([null, {}, { text: 12 }])('handles missing result text: %s', (result) => {
    expect(requestOutcomeNote({ ...base, status: 'executed', result })).toBe('Action r1 (koda_add_comment) was approved and done: ');
  });
  it('does not fabricate an outcome for a nonterminal request', () => {
    expect(() => requestOutcomeNote({ ...base, status: 'pending', result: null })).toThrow();
  });
});
