/**
 * Ticket reference matcher utility.
 * Matches and extracts ticket references (e.g., KODA-42) from text.
 */

export interface TicketRef {
  key: string;
  number: number;
}

/**
 * Check if text contains a ticket reference matching the given project key and ticket number.
 *
 * @param text The text to search in
 * @param projectKey The project key (e.g., 'KODA')
 * @param ticketNumber The ticket number (e.g., 42)
 * @returns true if the text contains a word-boundary match for PROJECTKEY-TICKETNUMBER
 */
export function containsTicketRef(
  text: string,
  projectKey: string,
  ticketNumber: number,
): boolean {
  const refs = extractTicketRefs(text);
  return refs.some(
    ref =>
      ref.key.toUpperCase() === projectKey.toUpperCase() &&
      ref.number === ticketNumber,
  );
}

/**
 * Extract all ticket references from text.
 *
 * @param text The text to extract ticket refs from
 * @returns Array of TicketRef objects with key and number
 */
export function extractTicketRefs(text: string): TicketRef[] {
  if (!text) {
    return [];
  }

  // Match patterns like KODA-42, PROJ-7, etc.
  // Word boundary before, then project key (letters/numbers), then dash, then number, then word boundary
  // Case insensitive matching to find all refs
  const regex = /\b([A-Z0-9]+)-(\d+)\b/gi;
  const refs: TicketRef[] = [];
  let match: RegExpExecArray | null;

  while ((match = regex.exec(text)) !== null) {
    const key = match[1];
    const number = parseInt(match[2], 10);

    // Only include valid positive ticket numbers
    if (number > 0) {
      refs.push({ key, number });
    }
  }

  return refs;
}