import { parseRulingText } from './ruling-keyword';

describe('parseRulingText', () => {
  it.each([
    [1, 'confirm: read 4f2e1aa store.ts:88; test green', { disposition: 'confirmed', reason: 'read 4f2e1aa store.ts:88; test green' }],
    [2, 'fixed 4f2e1aa — null check added', { disposition: 'fixed', sha: '4f2e1aa', reason: 'null check added' }],
    [3, 'Waive: out of scope per spec section 3', { disposition: 'waived', reason: 'out of scope per spec section 3' }],
    [4, 'override: kept as is', { disposition: 'overridden', reason: 'kept as is' }],
    [5, 'verified', { disposition: 'verified', reason: 'verified' }],
    [6, 'confirm', null], [7, 'looks fine', null], [8, 'fixed xyz', null],
    [9, '\n\nconfirm: ok\nmore evidence', { disposition: 'confirmed', reason: 'ok' }],
  ])('AC-%i: %s', (_ac, text, expected) => {
    expect(parseRulingText(text as string)).toEqual(expected);
  });
  it.each(['waive:', 'overridden: ', 'confirmed', 'confirm:\nreason', 'fixed 123456', 'fixed ' + 'a'.repeat(41), 'verified junk', 'fixed 1234567junk'])('rejects %s', (text) => {
    expect(parseRulingText(text)).toBeNull();
  });
  it.each([
    ['FIXED ABCDEF0', { disposition: 'fixed', sha: 'ABCDEF0', reason: '' }],
    ['fixed 1234567 - done', { disposition: 'fixed', sha: '1234567', reason: 'done' }],
    ['fixed 1234567: done', { disposition: 'fixed', sha: '1234567', reason: 'done' }],
    ['Waived: enough', { disposition: 'waived', reason: 'enough' }],
    ['Overridden: enough', { disposition: 'overridden', reason: 'enough' }],
    ['Confirmed: enough', { disposition: 'confirmed', reason: 'enough' }],
    ['verify: tested', { disposition: 'verified', reason: 'tested' }],
    ['  \r\n verified \r\nignored', { disposition: 'verified', reason: 'verified' }],
  ])('accepts %s', (text, expected) => expect(parseRulingText(text as string)).toEqual(expected));
});
