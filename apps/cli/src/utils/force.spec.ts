jest.mock('chalk', () => ({ red: (s: string) => s, green: (s: string) => s, yellow: (s: string) => s, gray: (s: string) => s, cyan: { bold: (s: string) => s } }));

import { requireForce } from './force';

describe('requireForce', () => {
  let exitSpy: jest.SpyInstance;
  let errorSpy: jest.SpyInstance;

  beforeEach(() => {
    exitSpy = jest.spyOn(process, 'exit').mockImplementation((() => {}) as never);
    errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => jest.restoreAllMocks());

  it('returns true and does nothing when --force is set', () => {
    expect(requireForce(true)).toBe(true);
    expect(exitSpy).not.toHaveBeenCalled();
  });

  it.each([undefined, false])('exits 1 with the hint when --force is %p', (force) => {
    expect(requireForce(force)).toBe(false);
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('Use --force to confirm deletion'));
    expect(exitSpy).toHaveBeenCalledWith(1);
  });
});
