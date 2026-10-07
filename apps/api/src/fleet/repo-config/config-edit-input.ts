import { ValidationAppException } from '@nathapp/nestjs-common';
import { isAllowedNaxPath, NAX_CONFIG_LIMITS } from '../common/nax-config-paths';
import type { ConfigFileEdit } from '../common/config-jobs';

/** A git commit or blob id: SHA-1 (40) or SHA-256 (64), lowercase hex. */
export const GIT_OBJECT_RE = /^[0-9a-f]{40}([0-9a-f]{24})?$/;

function fail(reason: string): never {
  throw new ValidationAppException({ reason }, 'fleet.configEditInput');
}

const bytes = (s: string): number => Buffer.byteLength(s, 'utf8');
const shown = (p: unknown): string => (typeof p === 'string' ? p.slice(0, 200) : typeof p);

function edit(raw: unknown): ConfigFileEdit {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) fail('edit must be an object');
  const { path, op, content, baseSha } = raw as Record<string, unknown>;
  if (typeof path !== 'string' || !isAllowedNaxPath(path)) fail(`path not allowed: ${shown(path)}`);
  if (op !== 'put' && op !== 'delete') fail(`op must be put or delete: ${path}`);
  if (baseSha !== null && (typeof baseSha !== 'string' || !GIT_OBJECT_RE.test(baseSha))) fail(`baseSha must be null or a git object id: ${path}`);
  if (op === 'put') {
    if (typeof content !== 'string') fail(`content required for put: ${path}`);
    if (content.includes('\u0000')) fail(`content must be text: ${path}`);
    if (bytes(content) > NAX_CONFIG_LIMITS.maxFileBytes) fail(`size over ${NAX_CONFIG_LIMITS.maxFileBytes} bytes: ${path}`);
    return { path, op, content, baseSha: baseSha as string | null };
  }
  if (content !== undefined) fail(`content not allowed for delete: ${path}`);
  if (baseSha === null) fail(`baseSha required for delete: ${path}`);
  return { path, op, baseSha: baseSha as string };
}

/** Spec §1 limits and the §2 allowlist; the runner re-checks every path (spec §5 step 3). */
export function validateConfigEdits(raw: unknown): ConfigFileEdit[] {
  if (!Array.isArray(raw) || raw.length === 0 || raw.length > NAX_CONFIG_LIMITS.maxEdits) fail(`edits must hold 1..${NAX_CONFIG_LIMITS.maxEdits} items`);
  const edits = raw.map(edit);
  const seen = new Set<string>();
  for (const e of edits) {
    // macOS clones are case-insensitive: two paths differing only by case would write one file.
    const key = e.path.toLowerCase();
    if (seen.has(key)) fail(`duplicate path: ${e.path}`);
    seen.add(key);
  }
  const total = edits.reduce((sum, e) => sum + (e.content === undefined ? 0 : bytes(e.content)), 0);
  if (total > NAX_CONFIG_LIMITS.maxTotalBytes) fail(`size over ${NAX_CONFIG_LIMITS.maxTotalBytes} bytes in total`);
  return edits;
}

export function validatePrTitle(raw: unknown): string {
  const title = typeof raw === 'string' ? raw.trim() : '';
  if (title.length === 0 || title.length > NAX_CONFIG_LIMITS.maxPrTitleChars || /[\r\n]/.test(title)) {
    fail(`prTitle must be 1..${NAX_CONFIG_LIMITS.maxPrTitleChars} characters on one line`);
  }
  return title;
}

export function validatePrBody(raw: unknown): string | null {
  if (raw === undefined || raw === null) return null;
  if (typeof raw !== 'string' || bytes(raw) > NAX_CONFIG_LIMITS.maxPrBodyBytes) fail(`prBody must be text of at most ${NAX_CONFIG_LIMITS.maxPrBodyBytes} bytes`);
  return raw;
}

export function validateBaseSha(raw: unknown): string {
  if (typeof raw !== 'string' || !GIT_OBJECT_RE.test(raw)) fail('baseSha must be a git commit id');
  return raw;
}
