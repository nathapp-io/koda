/**
 * Fleet S5b US-002 (3c-2-D2) — the per-project Markdown corpus patterns.
 *
 * Pure on purpose: no Nest, no database, no forge. `KnowledgeRepoIndexer` asks these functions which tree
 * entries a pass indexes; `ProjectKnowledgeController` validates what an admin saves. The syntax is deliberately
 * tiny — a `/`-separated path where a `**` segment matches zero or more whole segments and `*` inside a segment
 * matches any run of characters other than `/`; everything else matches itself. No `?`, classes, braces or
 * negation, and a pattern only ever selects Markdown.
 */

/** 3c-1's fixed corpus, expressed as patterns. Used when a project has saved none. */
export const DEFAULT_KNOWLEDGE_PATTERNS: readonly string[] = [
  'README.md',
  '.nax/context.md',
  'AGENTS.md',
  'docs/**/*.md',
  '.nax/features/*/spec.md',
];

/** The `patternsKey` of a project with no custom patterns. */
export const DEFAULT_PATTERNS_KEY = 'default';

/** 3c-2-D2 limits: 1 to 50 patterns, each 1 to 200 characters. */
export const KNOWLEDGE_PATTERN_COUNT_MAX = 50;
export const KNOWLEDGE_PATTERN_LENGTH_MAX = 200;

/** The characters a pattern may use; `'/abs.md'` is rejected by its own rule, not by this class. */
const PATTERN_CHARS = /^[A-Za-z0-9._\-*/]+$/;
const EMPTY_PATH: readonly string[] = [];

/** The first failing entry's reason, or the list's own reason when the input is not a 1-50 item array. */
export interface KnowledgePatternsRejection {
  ok: false;
  reason: string;
}
export type KnowledgePatternsParse = { ok: true; value: string[] } | KnowledgePatternsRejection;

/** True when `path` (a repository-relative file path) matches one pattern. */
export function matchesKnowledgePattern(path: string, pattern: string): boolean {
  return matchSegments(splitPath(path), 0, splitPath(pattern), 0);
}

function splitPath(value: string): string[] {
  return value.length === 0 ? [...EMPTY_PATH] : value.split('/');
}

/** Recursive on segments: at most one `**` step per pattern segment, and patterns stay short. */
function matchSegments(path: string[], at: number, pattern: string[], index: number): boolean {
  if (index === pattern.length) return at === path.length;
  if (pattern[index] === '**') {
    for (let skip = at; skip <= path.length; skip += 1) {
      if (matchSegments(path, skip, pattern, index + 1)) return true;
    }
    return false;
  }
  if (at === path.length) return false;
  return matchesSegment(path[at], pattern[index]) && matchSegments(path, at + 1, pattern, index + 1);
}

/** One segment against one pattern segment: literal characters, with `*` matching any run (never a `/`). */
function matchesSegment(value: string, pattern: string): boolean {
  let v = 0;
  let p = 0;
  let star = -1;
  let mark = 0;
  while (v < value.length) {
    if (p < pattern.length && pattern[p] === value[v]) {
      v += 1;
      p += 1;
    } else if (p < pattern.length && pattern[p] === '*') {
      star = p;
      mark = v;
      p += 1;
    } else if (star >= 0) {
      // Backtrack to the last `*` and let it consume one more character.
      p = star + 1;
      mark += 1;
      v = mark;
    } else {
      return false;
    }
  }
  while (p < pattern.length && pattern[p] === '*') p += 1;
  return p === pattern.length;
}

/**
 * Validates an untrusted pattern list: 1 to 50 strings, each trimmed, 1 to 200 characters, Markdown, a relative
 * path with no empty, `.` or `..` segment and `**` only as a whole segment. Duplicates are dropped, first kept.
 */
export function parseKnowledgePatterns(input: unknown): KnowledgePatternsParse {
  if (!Array.isArray(input) || input.length < 1 || input.length > KNOWLEDGE_PATTERN_COUNT_MAX) {
    return { ok: false, reason: 'patterns' };
  }
  const value: string[] = [];
  for (let index = 0; index < input.length; index += 1) {
    const pattern = normalisePattern(input[index]);
    if (pattern === null) return { ok: false, reason: `patterns[${index}]` };
    if (!value.includes(pattern)) value.push(pattern);
  }
  return { ok: true, value };
}

/** The stored form of one entry, or null when it is not a usable pattern. */
function normalisePattern(entry: unknown): string | null {
  if (typeof entry !== 'string') return null;
  const pattern = entry.trim();
  if (pattern.length < 1 || pattern.length > KNOWLEDGE_PATTERN_LENGTH_MAX) return null;
  if (!pattern.endsWith('.md') || !PATTERN_CHARS.test(pattern) || pattern.startsWith('/')) return null;
  for (const segment of pattern.split('/')) {
    if (segment.length === 0) return null;
    if (segment === '.' || segment === '..') return null;
    if (segment.includes('**') && segment !== '**') return null;
  }
  return pattern;
}

/**
 * A pass's snapshot of the patterns it selected with. A saved list changes the key, so a pass that started before
 * the save keeps the old key on its row and the next pass re-selects (3c-2-D2).
 */
export function knowledgePatternsKey(patterns: readonly string[] | null): string {
  return patterns === null ? DEFAULT_PATTERNS_KEY : patterns.join('\n');
}
