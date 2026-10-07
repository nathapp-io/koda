import { NAX_CONFIG_LIMITS, isAllowedNaxPath, type ConfigEditMode, type ConfigEditPayload, type ConfigFileEdit, type ConfigJobKind } from '@nathapp/fleet-protocol';

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);
const SHA = /^[0-9a-f]{40,64}$/;
const MODES: readonly ConfigEditMode[] = ['edit', 'regenerate', 'drift'];
const bytes = (text: string): number => Buffer.byteLength(text, 'utf8');
const hasControl = (v: string): boolean => [...v].some((ch) => ch.charCodeAt(0) < 32 || ch.charCodeAt(0) === 127);

function parseEdit(raw: unknown): ConfigFileEdit | null {
  if (!isObj(raw)) return null;
  const { path, op, content, baseSha } = raw;
  if (typeof path !== 'string' || !isAllowedNaxPath(path)) return null;
  if (baseSha !== null && (typeof baseSha !== 'string' || !SHA.test(baseSha))) return null;
  if (op === 'delete') return content === undefined ? { path, op, baseSha } : null;
  if (op !== 'put' || typeof content !== 'string' || content.includes('\0') || bytes(content) > NAX_CONFIG_LIMITS.maxFileBytes) return null;
  return { path, op, content, baseSha };
}

function parseEdits(raw: unknown, mode: ConfigEditMode): ConfigFileEdit[] | null {
  if (!Array.isArray(raw) || raw.length > NAX_CONFIG_LIMITS.maxEdits) return null;
  if (mode === 'edit' ? raw.length === 0 : raw.length > 0) return null;
  const edits = raw.map(parseEdit);
  if (edits.some((e) => e === null)) return null;
  const clean = edits as ConfigFileEdit[];
  if (new Set(clean.map((e) => e.path)).size !== clean.length) return null;
  const total = clean.reduce((sum, e) => sum + (e.content === undefined ? 0 : bytes(e.content)), 0);
  return total > NAX_CONFIG_LIMITS.maxTotalBytes ? null : clean;
}

/**
 * D30, S3 §3: the server is trusted to deliver, not to be well formed. Every path is re-checked against the shared
 * allowlist (never a `.env` profile), every limit is re-applied, and only validated fields are copied.
 */
export function parseConfigEditPayload(raw: unknown, command: ConfigJobKind): ConfigEditPayload | null {
  if (!isObj(raw)) return null;
  const mode = raw['mode'];
  if (typeof mode !== 'string' || !MODES.includes(mode as ConfigEditMode)) return null;
  const typedMode = mode as ConfigEditMode;
  if ((command === 'CONFIG_DRIFT') !== (typedMode === 'drift')) return null;
  const baseSha = raw['baseSha'];
  if (typeof baseSha !== 'string' || !SHA.test(baseSha)) return null;
  const edits = parseEdits(raw['edits'], typedMode);
  if (edits === null) return null;
  const prTitle = raw['prTitle'] ?? null;
  if (typedMode === 'drift' ? prTitle !== null : typeof prTitle !== 'string' || prTitle.length === 0 || prTitle.length > NAX_CONFIG_LIMITS.maxPrTitleChars || hasControl(prTitle)) return null;
  const prBody = raw['prBody'] ?? null;
  if (prBody !== null && (typeof prBody !== 'string' || prBody.includes('\0') || bytes(prBody) > NAX_CONFIG_LIMITS.maxPrBodyBytes)) return null;
  return { mode: typedMode, edits, prTitle: prTitle as string | null, prBody: prBody as string | null, baseSha };
}
