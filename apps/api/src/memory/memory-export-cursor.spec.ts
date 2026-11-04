import { decodeMemoryExportCursor, encodeMemoryExportCursor } from './memory-export-cursor';

describe('memory export cursor (memory-notes US-006)', () => {
  it('AC-1: a cursor round-trips its updatedAt and id', () => {
    const key = { updatedAt: new Date('2026-11-21T09:03:00.123Z'), id: 'mem-01' };

    const decoded = decodeMemoryExportCursor(encodeMemoryExportCursor(key));

    expect(decoded).not.toBeNull();
    expect(decoded?.updatedAt.getTime()).toBe(key.updatedAt.getTime());
    expect(decoded?.id).toBe(key.id);
  });

  it('AC-1: the wire shape is the base64url `iso|id` of the timeline cursor', () => {
    const key = { updatedAt: new Date('2026-01-02T03:04:05.006Z'), id: 'cuid-xyz' };

    expect(encodeMemoryExportCursor(key)).toBe(
      Buffer.from(`2026-01-02T03:04:05.006Z|cuid-xyz`, 'utf8').toString('base64url'),
    );
  });

  it('AC-1: an id carrying the separator survives the round trip', () => {
    const key = { updatedAt: new Date('2026-11-21T09:03:00.123Z'), id: 'a|b' };

    expect(decodeMemoryExportCursor(encodeMemoryExportCursor(key))).toEqual(key);
  });

  it.each([
    ['garbage'],
    [''],
    // A well-formed ISO timestamp with no separator after it.
    [Buffer.from('2026-11-21T09:03:00.123Z', 'utf8').toString('base64url')],
    // A separator with no ISO timestamp before it.
    [Buffer.from('not-a-timestamp|mem-01', 'utf8').toString('base64url')],
    // An ISO timestamp that is not UTC or not millisecond-precise.
    [Buffer.from('2026-11-21|mem-01', 'utf8').toString('base64url')],
    // A separator with no id after it.
    [Buffer.from('2026-11-21T09:03:00.123Z|', 'utf8').toString('base64url')],
  ])('AC-2: %j decodes to null', (cursor) => {
    expect(decodeMemoryExportCursor(cursor)).toBeNull();
  });

  it.each([
    // Node's decoder skips characters outside its alphabet, so these would decode to a valid cursor unchecked.
    ['!!'],
    ['%20'],
    [' '],
    // Standard base64's own characters and padding: not what this module writes.
    ['+'],
    ['/'],
    ['='],
  ])('AC-2: a cursor with %j appended is refused, not silently trimmed', (junk) => {
    const valid = encodeMemoryExportCursor({ updatedAt: new Date('2026-11-21T09:03:00.123Z'), id: 'mem-01' });

    expect(decodeMemoryExportCursor(valid)).not.toBeNull();
    expect(decodeMemoryExportCursor(valid + junk)).toBeNull();
  });
});
