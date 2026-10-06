import { mapPrState } from './pr-state';

describe('mapPrState', () => {
  it.each([
    [{ merged: true, state: 'closed', draft: false }, 'merged'],
    [{ merged: false, state: 'open', draft: true }, 'draft'],
    [{ merged: false, state: 'open', draft: false }, 'open'],
    [{ merged: false, state: 'closed', draft: false }, 'closed'],
    [{ merged: false, state: 'locked', draft: false }, 'locked'],
  ])('%j -> %s', (pr, expected) => {
    expect(mapPrState(pr)).toBe(expected);
  });
});
