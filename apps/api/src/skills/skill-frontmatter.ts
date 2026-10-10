import { SkillResolveError } from './skill-resolver';

const NAME_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/;
const MAX_DESCRIPTION_LENGTH = 1024;

/**
 * Reads `name` and `description` from a SKILL.md frontmatter block. Only single-line scalars are
 * supported; other keys are ignored. Throws `invalid_skill` for anything else.
 */
export function parseSkillFrontmatter(text: string): { name: string; description: string } {
  const lines = normalize(text).split('\n');
  if (lines[0] !== '---') throw invalidSkill();

  const end = lines.indexOf('---', 1);
  if (end === -1) throw invalidSkill();

  const block = lines.slice(1, end);
  const name = scalar(block, 'name');
  if (name === undefined || !NAME_PATTERN.test(name)) throw invalidSkill();

  const description = scalar(block, 'description');
  if (description === undefined || description === '') throw invalidSkill();

  return { name, description: description.slice(0, MAX_DESCRIPTION_LENGTH) };
}

/** Strips a leading UTF-8 BOM and normalizes CRLF line endings. */
function normalize(text: string): string {
  return text.replace(/^\uFEFF/, '').replace(/\r\n/g, '\n');
}

/**
 * The value of the first `key:` line, with one pair of matching surrounding quotes removed.
 * Returns undefined when there is no such line, and throws for a block scalar (`>` or `|`).
 */
function scalar(block: string[], key: string): string | undefined {
  const prefix = key + ':';
  const line = block.find((candidate) => candidate.startsWith(prefix));
  if (line === undefined) return undefined;

  const raw = line.slice(prefix.length).trim();
  if (raw === '>' || raw === '|' || raw.startsWith('>') || raw.startsWith('|')) throw invalidSkill();
  return unquote(raw);
}

function unquote(value: string): string {
  const quoted = value.length >= 2 && (value[0] === '"' || value[0] === "'") && value.endsWith(value[0]);
  return quoted ? value.slice(1, -1) : value;
}

function invalidSkill(): SkillResolveError {
  return new SkillResolveError('invalid_skill');
}
