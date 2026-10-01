import { apiErrorCode } from './api-error-code';

describe('apiErrorCode', () => {
  it('reads ret from the parsed error body the generated client throws', () => {
    expect(apiErrorCode({ ret: 409, message: 'An active job already runs this feature: j1' })).toBe(409);
  });

  it('answers undefined for anything without a numeric ret', () => {
    for (const err of [new Error('x'), 'text', null, undefined, { ret: '409' }, { status: 409 }]) {
      expect(apiErrorCode(err)).toBeUndefined();
    }
  });
});
