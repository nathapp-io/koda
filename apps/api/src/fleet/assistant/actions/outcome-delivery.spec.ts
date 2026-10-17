import { DELIVERY_HEADER, deliveryText, MAX_DELIVERED_NOTES } from './outcome-delivery';

/**
 * Fleet S5b 2aw US-001 — 2aw-D2: the text an agent is handed when it is given the outcome notes of the actions it
 * proposed. Pure: no clock, no database, no rounding. `maxBytes` is the runner's own bound on `THREAD_INPUT` text
 * and `initialMessage.text` (`THREAD_LIMITS.messageMaxBytes`, 32,768).
 */
const HEADER = 'Updates on actions you proposed:';
const LIMIT = 32_768;

describe('deliveryText (2aw-D2, US-001)', () => {
  it('AC-1: no notes returns the user text unchanged and delivers 0', () => {
    expect(deliveryText([], 'hello', LIMIT)).toEqual({ text: 'hello', delivered: 0 });
  });

  it('AC-2: two notes are one block under the header, then a blank line, then the user text', () => {
    expect(DELIVERY_HEADER).toBe(HEADER);
    expect(deliveryText(['note A', 'note B'], 'hello', LIMIT).text).toBe(`${HEADER}\nnote A\nnote B\n\nhello`);
  });

  it('AC-3: both notes are counted in delivered', () => {
    expect(deliveryText(['note A', 'note B'], 'hello', LIMIT).delivered).toBe(2);
  });

  it('AC-4: the first note that does not fit stops the list, so only note A is delivered', () => {
    const oneNote = `${HEADER}\nnote A\n\nhello`;
    expect(deliveryText(['note A', 'note B', 'note C'], 'hello', Buffer.byteLength(oneNote, 'utf8')).delivered).toBe(1);
  });

  it('AC-5: that text is the header, the first note, a blank line and the user text', () => {
    const oneNote = `${HEADER}\nnote A\n\nhello`;
    expect(deliveryText(['note A', 'note B', 'note C'], 'hello', Buffer.byteLength(oneNote, 'utf8')).text).toBe(oneNote);
  });

  it('AC-6: the budget counts UTF-8 bytes, not characters', () => {
    const note = '😀'.repeat(10);
    const characters = [...note].length;
    // The character count fits this budget; the byte count (4 bytes per character) does not.
    const charBudget = HEADER.length + 1 + characters + 2 + 'hello'.length;

    expect(characters).toBe(10);
    expect(Buffer.byteLength(note, 'utf8')).toBe(40);
    expect(deliveryText([note], 'hello', charBudget)).toEqual({ text: 'hello', delivered: 0 });
  });

  it('delivers a block that lands exactly on maxBytes', () => {
    const exact = `${HEADER}\nnote A\n\nhello`;
    expect(deliveryText(['note A'], 'hello', Buffer.byteLength(exact, 'utf8'))).toEqual({ text: exact, delivered: 1 });
  });

  it('caps a delivery at MAX_DELIVERED_NOTES notes', () => {
    expect(MAX_DELIVERED_NOTES).toBe(20);
  });
});
