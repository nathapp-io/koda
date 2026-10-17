/** 2aw-D2: the line that opens a delivery block; English only, like `outcomeNote` (2a-D9). */
export const DELIVERY_HEADER = 'Updates on actions you proposed:';

/** 2aw-D2: how many outcome notes one hand-off may carry; the rest stay undelivered for the next message. */
export const MAX_DELIVERED_NOTES = 20;

/**
 * 2a-D9: the statuses that have an `outcomeNote`, so the only ones `sendMessage` marks delivered (2aw-D3) and the
 * only ones `findThreadAssign` rebuilds the text from (2aw-D4).
 */
export const DELIVERABLE_STATUSES = ['EXECUTED', 'FAILED', 'REJECTED', 'EXPIRED'] as const;

/**
 * 2aw-D2: the text the agent receives: the header, one note per line block, a blank line, then the user's text.
 * Notes are taken in the given order while the whole text stays within `maxBytes` UTF-8 bytes; the first note that
 * does not fit stops the list. No note fits, or none given: the user's text unchanged, delivered 0.
 *
 * Byte-bounded on purpose: the runner refuses a `THREAD_INPUT` text or `initialMessage.text` over
 * `THREAD_LIMITS.messageMaxBytes` (32,768), and a note's note-result is capped at 500 characters, not bytes.
 */
export function deliveryText(notes: readonly string[], userText: string, maxBytes: number): { text: string; delivered: number } {
  const fits = (text: string): boolean => Buffer.byteLength(text, 'utf8') <= maxBytes;
  let delivered = 0;
  let text = userText;
  for (const [i] of notes.entries()) {
    const candidate = `${DELIVERY_HEADER}\n${notes.slice(0, i + 1).join('\n')}\n\n${userText}`;
    if (!fits(candidate)) break;
    delivered = i + 1;
    text = candidate;
  }
  return { text, delivered };
}
