/**
 * Runtime mirror of packages/fleet-protocol/src/nax-config-paths.ts (fleet S3 §2, D467). The API image does not ship
 * workspace packages; nax-config-paths.spec.ts runs one path table against both and pins the limits equal.
 */
export type NaxPathGroup = 'rules' | 'context' | 'config' | 'profiles' | 'constitution';

export const NAX_CONFIG_LIMITS = {
  maxEdits: 50,
  maxFileBytes: 262_144,
  maxTotalBytes: 1_048_576,
  maxPathChars: 512,
  maxPrTitleChars: 200,
  maxPrBodyBytes: 8_192,
} as const;

/** One path segment: no spaces, no shell or glob characters. Case-sensitive. */
const SEGMENT_RE = /^[A-Za-z0-9._-]+$/;
/** nax profile names (#161 bound) plus `.json`. */
const PROFILE_FILE_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}\.json$/;

const ROOT_FILES: Readonly<Record<string, NaxPathGroup>> = {
  'context.md': 'context',
  'config.json': 'config',
  'constitution.md': 'constitution',
};
const MONO_FILES: Readonly<Record<string, NaxPathGroup>> = { 'context.md': 'context', 'config.json': 'config' };

export function naxPathGroup(path: string): NaxPathGroup | null {
  if (typeof path !== 'string' || path.length === 0 || path.length > NAX_CONFIG_LIMITS.maxPathChars) return null;
  if (path.includes('\\') || path.includes('\u0000') || path.startsWith('/')) return null;
  const parts = path.split('/');
  const badSegment = (p: string): boolean => p === '' || p === '.' || p === '..' || !SEGMENT_RE.test(p) || p.toLowerCase().endsWith('.env');
  if (parts.some(badSegment) || parts[0] !== '.nax' || parts.length < 2) return null;
  const top = parts[1];
  const rest = parts.slice(2);
  const file = parts[parts.length - 1];
  if (rest.length === 0) return Object.prototype.hasOwnProperty.call(ROOT_FILES, top) ? ROOT_FILES[top] : null;
  if (top === 'rules') return file.endsWith('.md') && file.length > '.md'.length ? 'rules' : null;
  if (top === 'profiles') return rest.length === 1 && PROFILE_FILE_RE.test(file) ? 'profiles' : null;
  if (top === 'mono' && rest.length >= 2) return Object.prototype.hasOwnProperty.call(MONO_FILES, file) ? MONO_FILES[file] : null;
  return null;
}

export function isAllowedNaxPath(path: string): boolean {
  return naxPathGroup(path) !== null;
}
