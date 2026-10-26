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
});
