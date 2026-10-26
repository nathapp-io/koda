import { approvalInputHash, freezeApprovalInput } from './approval-input';

describe('approval input freezing', () => {
  it('hashes the canonical JSON of the parsed input with SHA-256', () => {
    expect(approvalInputHash({ labelId: 'l1' })).toBe(
      '2a758b16eaedd796f091841a3607825ba3a5e3fd9be6a2c27dd934ca94d7c026',
    );
  });

  it('hashes the same value the same way whatever the member order', () => {
    expect(approvalInputHash({ b: 1, a: { d: 2, c: [3] } })).toBe(
      approvalInputHash({ a: { c: [3], d: 2 }, b: 1 }),
    );
  });

  it('freezes what a JSON round-trip of the parsed input answers', () => {
    expect(freezeApprovalInput({ labelId: 'l1', dropped: undefined })).toEqual({ labelId: 'l1' });
  });

  it('freezes a value with no JSON form as null rather than undefined', () => {
    expect(freezeApprovalInput(undefined)).toBeNull();
  });

  it('distinguishes values that only JSON writes apart', () => {
    // `canonicalJson` alone sees a boxed number as an empty object, so hashing the raw value would
    // give `{ amount: new Number(7) }` and `{ amount: new Number(8) }` one hash while storing 7 and 8.
    expect(freezeApprovalInput({ amount: new Number(7) })).toEqual({ amount: 7 });
    expect(approvalInputHash({ amount: new Number(7) })).not.toBe(approvalInputHash({ amount: new Number(8) }));
  });

  it('gives distinct frozen values distinct hashes', () => {
    expect(approvalInputHash({ amount: 7 })).not.toBe(approvalInputHash({ amount: 8 }));
    expect(approvalInputHash({ labelId: 'l1' })).not.toBe(approvalInputHash({ labelId: 'l2' }));
  });

  it('reproduces the original hash from the stored input', () => {
    const parsed = { amount: new Number(7), at: new Date('2026-11-05T09:00:00Z'), nested: { b: 1, a: 2 } };
    const stored = freezeApprovalInput(parsed);
    expect(approvalInputHash(stored)).toBe(approvalInputHash(parsed));
  });
});
