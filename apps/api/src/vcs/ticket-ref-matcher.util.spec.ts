import { containsTicketRef, extractTicketRefs } from './ticket-ref-matcher.util';

describe('extractTicketRefs', () => {
  it('extracts a single ref', () => {
    const refs = extractTicketRefs('Fixes KODA-42 in this commit');
    expect(refs).toHaveLength(1);
    expect(refs[0]).toEqual({ key: 'KODA', number: 42 });
  });

  it('extracts multiple refs from the same text', () => {
    const refs = extractTicketRefs('Refs PROJ-1 and PROJ-2 and PROJ-3');
    expect(refs).toHaveLength(3);
    expect(refs.map((r) => r.number)).toEqual([1, 2, 3]);
  });

  it('is case-insensitive for the key', () => {
    const refs = extractTicketRefs('closes koda-7');
    expect(refs).toHaveLength(1);
    expect(refs[0].key).toBe('koda');
    expect(refs[0].number).toBe(7);
  });

  it('returns empty array for text with no refs', () => {
    expect(extractTicketRefs('nothing to see here')).toHaveLength(0);
  });

  it('returns empty array for empty string', () => {
    expect(extractTicketRefs('')).toHaveLength(0);
  });

  it('returns empty array for null/undefined-like falsy values', () => {
    expect(extractTicketRefs(null as unknown as string)).toHaveLength(0);
  });

  it('skips invalid zero ticket numbers', () => {
    const refs = extractTicketRefs('BAD-0 should be skipped');
    expect(refs).toHaveLength(0);
  });

  it('handles alphanumeric project keys', () => {
    const refs = extractTicketRefs('ABC123-99 done');
    expect(refs).toHaveLength(1);
    expect(refs[0]).toEqual({ key: 'ABC123', number: 99 });
  });

  it('handles multi-line text', () => {
    const refs = extractTicketRefs('line one KODA-1\nline two KODA-2');
    expect(refs).toHaveLength(2);
  });
});

describe('containsTicketRef', () => {
  it('returns true when the ref is present', () => {
    expect(containsTicketRef('Fixes KODA-42', 'KODA', 42)).toBe(true);
  });

  it('returns false when the ticket number differs', () => {
    expect(containsTicketRef('Fixes KODA-42', 'KODA', 99)).toBe(false);
  });

  it('returns false when the project key differs', () => {
    expect(containsTicketRef('Fixes KODA-42', 'PROJ', 42)).toBe(false);
  });

  it('is case-insensitive for the project key comparison', () => {
    expect(containsTicketRef('closes koda-7', 'KODA', 7)).toBe(true);
  });

  it('returns false for empty text', () => {
    expect(containsTicketRef('', 'KODA', 1)).toBe(false);
  });
});
