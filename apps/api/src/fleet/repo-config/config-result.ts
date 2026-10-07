import { CONFIG_RESULT_LIMITS } from '../common/config-jobs';
import type { ConfigJobOutcome, ConfigJobResult } from '../common/config-jobs';

const OUTCOMES: readonly ConfigJobOutcome[] = ['ok', 'no_changes', 'drift', 'conflict', 'invalid', 'push_failed', 'pr_failed', 'timeout'];

const isFile = (f: unknown): f is string => typeof f === 'string' && f.length > 0 && f.length <= CONFIG_RESULT_LIMITS.maxFileChars;

/** Runner-reported config job result (untrusted, spec §3). Null when any field breaks its bound: one mirrored field, dropped whole. */
export function parseConfigResult(raw: unknown): ConfigJobResult | null {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null;
  const { outcome, files, output } = raw as Record<string, unknown>;
  if (typeof outcome !== 'string' || !(OUTCOMES as readonly string[]).includes(outcome)) return null;
  if (files !== undefined && (!Array.isArray(files) || files.length > CONFIG_RESULT_LIMITS.maxFiles || !files.every(isFile))) return null;
  if (output !== undefined && (typeof output !== 'string' || Buffer.byteLength(output, 'utf8') > CONFIG_RESULT_LIMITS.maxOutputBytes)) return null;
  return {
    outcome: outcome as ConfigJobOutcome,
    ...(files !== undefined ? { files: [...(files as string[])] } : {}),
    ...(output !== undefined ? { output: output as string } : {}),
  };
}
