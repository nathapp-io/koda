import { ValidationAppException } from '@nathapp/nestjs-common';
import { MAX_DISPATCH_TICKETS, parseDispatchRefs } from './ticket-refs';

const reasonOf = (fn: () => unknown): unknown => {
  try {
    fn();
  } catch (error) {
    expect(error).toBeInstanceOf(ValidationAppException);
    return JSON.stringify(error);
  }
  throw new Error('expected a throw');
};

describe('parseDispatchRefs (C9 D450)', () => {
  it('upper-cases, trims and deduplicates', () => {
    expect(parseDispatchRefs([' web-1', 'WEB-2', 'Web-1'], 'WEB')).toEqual([
      { ref: 'WEB-1', number: 1 },
      { ref: 'WEB-2', number: 2 },
    ]);
  });

  it('returns [] for no refs', () => {
    expect(parseDispatchRefs([], 'WEB')).toEqual([]);
  });

  it.each([
    ['another project key', 'OPS-1'],
    ['a CUID', 'clx0000000000000000000000'],
    ['an empty ref', '  '],
    ['a zero number', 'WEB-0'],
  ])('refuses %s, naming the ref', (_label, ref) => {
    expect(reasonOf(() => parseDispatchRefs([ref], 'WEB'))).toContain(`ticket ${ref.trim().toUpperCase()}`);
  });

  it(`refuses more than ${MAX_DISPATCH_TICKETS} distinct refs`, () => {
    const refs = Array.from({ length: MAX_DISPATCH_TICKETS + 1 }, (_, i) => `WEB-${i + 1}`);
    expect(reasonOf(() => parseDispatchRefs(refs, 'WEB'))).toContain('too many tickets');
  });
});
