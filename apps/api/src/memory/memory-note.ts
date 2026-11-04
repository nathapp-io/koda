import { MemoryKind } from '../common/enums';

/**
 * US-001 — a NOTE memory item is a Markdown note, not a fact.
 *
 * `MemoryItem` is a subject/predicate/object triple, which fits a decision and not a note with a type and an
 * index line (#376). A note reuses the triple: `subject` is the slug, `predicate` the type, `object` the
 * Markdown body, and `description` the one-line index entry. The limits below are nax's own
 * (nax `packages/nax-agent/src/memory/types.ts`), so a note written here is a note nax can read back.
 */

/** A note slug: lowercase, digits and hyphens, 1..64 characters, never starting with a hyphen. */
export const MEMORY_NOTE_SLUG_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;

/** The note types nax knows. A note's `predicate` is one of these. */
export const MEMORY_NOTE_TYPES = ['user', 'feedback', 'project', 'reference'] as const;
export type MemoryNoteType = (typeof MEMORY_NOTE_TYPES)[number];

/** The Markdown body is capped in UTF-8 bytes, not characters, because that is what nax stores. */
export const MEMORY_NOTE_BODY_MAX_BYTES = 8192;

/** The index line, as nax's own memory index shows it. */
export const MEMORY_NOTE_DESCRIPTION_MAX_CHARS = 200;

/** The fields a note write judges, in the order `noteFieldError` reports them. */
export type MemoryNoteField = 'subject' | 'predicate' | 'object' | 'description';

export interface MemoryNoteInput {
  kind: string;
  subject: string;
  predicate: string;
  object?: string;
  /** `null` is how a JSON body spells "no value", so it reads as absent. */
  description?: string | null;
}

/** The trimmed description, or '' when the write carries none. */
function presentDescription(description: string | null | undefined): string {
  return (description ?? '').trim();
}

/** A body counts as present only when it holds something other than whitespace. */
function hasBody(object: string | undefined): boolean {
  return /[^\s]/.test(object ?? '');
}

/** The first note field `input` gets wrong, in the order a caller reads the note: slug, type, body, index line. */
function noteFieldProblem(input: MemoryNoteInput): MemoryNoteField | null {
  if (!MEMORY_NOTE_SLUG_RE.test(input.subject)) return 'subject';
  if (!(MEMORY_NOTE_TYPES as readonly string[]).includes(input.predicate)) return 'predicate';
  const object = input.object ?? '';
  if (!hasBody(object) || Buffer.byteLength(object, 'utf8') > MEMORY_NOTE_BODY_MAX_BYTES) return 'object';
  const description = presentDescription(input.description);
  if (description.length < 1 || description.length > MEMORY_NOTE_DESCRIPTION_MAX_CHARS) return 'description';
  return null;
}

/**
 * The first field of `input` that a write would reject, or null.
 *
 * For `kind: 'NOTE'` it checks, in this order, the slug, the type, the body (required, not blank, at most
 * 8192 UTF-8 bytes) and the description (required, 1..200 characters after trim). Every other kind keeps the
 * triple rules it has always had and must carry no description **at all**: any supplied value is refused,
 * including one that is empty or only whitespace, so a triple row can never store an index line nothing reads.
 * `undefined` and `null` are the two ways of supplying nothing. It is pure and synchronous so both write paths
 * — the REST route and the assistant tool — can call it before anything is read or written.
 */
export function noteFieldError(input: MemoryNoteInput): MemoryNoteField | null {
  if (input.kind === MemoryKind.NOTE) return noteFieldProblem(input);
  return input.description === undefined || input.description === null ? null : 'description';
}
