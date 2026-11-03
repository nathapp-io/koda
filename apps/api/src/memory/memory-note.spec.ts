/**
 * US-001 — the note shape a `MemoryItem` takes when its kind is `NOTE`.
 *
 * A note borrows nax's own limits (nax `packages/nax-agent/src/memory/types.ts`) so a Koda note round-trips
 * into a nax memory note: `subject` is the slug, `predicate` the type, `object` the Markdown body and
 * `description` the index line. `noteFieldError` is the one validator every write path calls, and it names
 * the first field that is wrong in a fixed order, so the caller can report it.
 */
import { MemoryKind } from '../common/enums';
import { buildActiveKey } from './prisma-memory-item.repository';
import {
  MEMORY_NOTE_BODY_MAX_BYTES,
  MEMORY_NOTE_DESCRIPTION_MAX_CHARS,
  MEMORY_NOTE_SLUG_RE,
  MEMORY_NOTE_TYPES,
  noteFieldError,
} from './memory-note';

/** A note that passes every check; each test breaks exactly one field of it. */
const validNote = {
  kind: MemoryKind.NOTE as string,
  subject: 'replay-budget',
  predicate: 'project',
  object: 'Budget stays 2,048 MiB.',
  description: 'replay budget',
};

describe('US-001 memory notes', () => {
  it('AC-1: MemoryKind.NOTE is the stored string NOTE', () => {
    expect(MemoryKind.NOTE).toBe('NOTE');
  });

  it('AC-2: a well-formed note has no field error', () => {
    expect(noteFieldError(validNote)).toBeNull();
    // The limits are nax's own, so a note written here is a note nax can read.
    expect(MEMORY_NOTE_SLUG_RE.test('replay-budget')).toBe(true);
    expect(MEMORY_NOTE_TYPES).toEqual(['user', 'feedback', 'project', 'reference']);
    expect(MEMORY_NOTE_BODY_MAX_BYTES).toBe(8192);
    expect(MEMORY_NOTE_DESCRIPTION_MAX_CHARS).toBe(200);
  });

  it('AC-3: a subject that is not a lowercase slug is rejected as subject', () => {
    expect(noteFieldError({ ...validNote, subject: 'Replay Budget' })).toBe('subject');
  });

  it('AC-4: a subject is at most 64 characters of [a-z0-9-] starting with [a-z0-9]', () => {
    expect(noteFieldError({ ...validNote, subject: 'a'.repeat(65) })).toBe('subject');
    expect(noteFieldError({ ...validNote, subject: 'a'.repeat(64) })).toBeNull();
    expect(noteFieldError({ ...validNote, subject: '-replay-budget' })).toBe('subject');
  });

  it('AC-5: a predicate outside the four note types is rejected as predicate', () => {
    expect(noteFieldError({ ...validNote, predicate: 'misc' })).toBe('predicate');
    for (const type of MEMORY_NOTE_TYPES) {
      expect(noteFieldError({ ...validNote, predicate: type })).toBeNull();
    }
  });

  it('AC-6: the body is capped at 8192 UTF-8 bytes, counted as bytes and not as characters', () => {
    expect(noteFieldError({ ...validNote, object: 'x'.repeat(8193) })).toBe('object');
    // 'é' is two UTF-8 bytes: 4096 of them are exactly 8192 bytes, 4097 are one byte over.
    const exact = 'é'.repeat(4096);
    expect(Buffer.byteLength(exact, 'utf8')).toBe(MEMORY_NOTE_BODY_MAX_BYTES);
    expect(noteFieldError({ ...validNote, object: exact })).toBeNull();
    expect(noteFieldError({ ...validNote, object: `${exact}é` })).toBe('object');
  });

  it('AC-7: the body is required and may not be blank', () => {
    expect(noteFieldError({ kind: validNote.kind, subject: validNote.subject, predicate: validNote.predicate, description: validNote.description })).toBe('object');
    expect(noteFieldError({ ...validNote, object: '   ' })).toBe('object');
    expect(noteFieldError({ ...validNote, object: '\n\t ' })).toBe('object');
  });

  it('AC-8: the description is required and at most 200 characters after trim', () => {
    expect(noteFieldError({ kind: validNote.kind, subject: validNote.subject, predicate: validNote.predicate, object: validNote.object })).toBe('description');
    expect(noteFieldError({ ...validNote, description: 'x'.repeat(201) })).toBe('description');
    expect(noteFieldError({ ...validNote, description: 'x'.repeat(200) })).toBeNull();
    expect(noteFieldError({ ...validNote, description: '   ' })).toBe('description');
  });

  it('AC-9: a non-note kind may carry no description', () => {
    expect(noteFieldError({ kind: 'FACT', subject: 's', predicate: 'p', description: 'x' })).toBe('description');
    expect(noteFieldError({ kind: 'FACT', subject: 's', predicate: 'p' })).toBeNull();
  });

  it('AC-10: a note keys on its slug alone, every other kind on its triple', () => {
    expect(buildActiveKey('p1', 'NOTE', 'replay-budget', 'project')).toBe('NOTE:replay-budget');
    expect(buildActiveKey('p1', 'NOTE', 'replay-budget', 'feedback')).toBe('NOTE:replay-budget');
    expect(buildActiveKey('p1', 'FACT', 's', 'p')).toBe('FACT:s:p');
  });
});
