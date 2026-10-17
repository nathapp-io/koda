import { asRecord, ticketPath } from './tool-input';

/**
 * US-002 (2b1-D8): the two input helpers every write tool shares, moved out of `action-tools.ts` unchanged.
 * `asRecord` turns any non-record body into absent fields; `ticketPath` is what every write result names a
 * ticket by.
 */
describe('US-002 AC-12: asRecord reads a non-record body as absent fields', () => {
  it('AC-12: an array is not a record', () => {
    expect(asRecord([1])).toEqual({});
  });

  it('answers the body itself when it is a record', () => {
    const input = { ref: 'KODA-1' };
    expect(asRecord(input)).toBe(input);
  });

  it.each([null, undefined, 'KODA-1', 7, true])('reads %s as absent fields', (value) => {
    expect(asRecord(value)).toEqual({});
  });

  it('reads an empty object as a record with no fields', () => {
    expect(asRecord({})).toEqual({});
  });
});

describe('US-002 AC-13: ticketPath names a ticket by its web path', () => {
  it('AC-13: builds /<slug>/tickets/<ref>', () => {
    expect(ticketPath('web', 'KODA-1')).toBe('/web/tickets/KODA-1');
  });

  it('does not rewrite its arguments', () => {
    expect(ticketPath('koda-api', 'KODA-12')).toBe('/koda-api/tickets/KODA-12');
  });
});
