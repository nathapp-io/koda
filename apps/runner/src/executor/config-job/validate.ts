import type { ConfigFileEdit, ConfigJobResult } from '@nathapp/fleet-protocol';
import { sanitizeDiagnostic } from '../../diagnostics';
import { parseNaxJson } from '../../nax/nax-cli';
import { PROFILE_NAME } from '../nax-process';
import { describeFailure, type NaxRun } from './regenerate';
import { raiseIfInterrupted, type ProcResult } from './types';

const PROFILE_FILE = /^\.nax\/profiles\/([^/]+)\.json$/;
const PACKAGE_CONFIG = /^\.nax\/mono\/.+\/config\.json$/;
const invalid = (output: string): ConfigJobResult => ({ outcome: 'invalid', output });

function errorMessageOf(stdout: string): string | null {
  try {
    const doc = JSON.parse(stdout) as { error?: { message?: unknown } };
    return typeof doc.error?.message === 'string' ? doc.error.message : null;
  } catch {
    return null;
  }
}

/** nax's JSON verdict for `config --json` (never the exit code, D96): null when nax printed a config document. */
function configError(result: ProcResult): string | null {
  const parsed = parseNaxJson(result);
  if (parsed.ok) return null;
  const message = errorMessageOf(result.stdout);
  return sanitizeDiagnostic(message ? `${parsed.code}: ${message}` : parsed.code);
}

function isJsonObject(text: string): boolean {
  try {
    const value: unknown = JSON.parse(text);
    return typeof value === 'object' && value !== null && !Array.isArray(value);
  } catch {
    return false;
  }
}

/**
 * S3 spec §5 step 6, in order, first failure wins: `nax rules lint` (the whole repo), the root config, each added or
 * changed repo profile, each added or changed package config (D490: a JSON-object check, nax has no command for it).
 */
export async function validateConfig(nax: NaxRun, repoDir: string, edits: readonly ConfigFileEdit[]): Promise<ConfigJobResult | null> {
  const lint = await nax(['rules', 'lint', '-d', repoDir]);
  raiseIfInterrupted(lint);
  if (lint.code !== 0) return invalid(describeFailure('nax rules lint', lint));
  const root = await nax(['config', '--json', '-d', repoDir]);
  raiseIfInterrupted(root);
  const rootError = configError(root);
  if (rootError) return invalid(`nax config --json: ${rootError}`);
  const puts = edits.filter((edit) => edit.op === 'put');
  for (const edit of puts) {
    const name = PROFILE_FILE.exec(edit.path)?.[1];
    if (name === undefined) continue;
    if (!PROFILE_NAME.test(name)) return invalid(`invalid profile file name: ${edit.path}`);
    const result = await nax(['config', '--profile', name, '--json', '-d', repoDir]);
    raiseIfInterrupted(result);
    const error = configError(result);
    if (error) return invalid(`nax config --profile ${name} --json: ${error}`);
  }
  const badPackage = puts.find((edit) => PACKAGE_CONFIG.test(edit.path) && !isJsonObject(edit.content ?? ''));
  return badPackage ? invalid(`${badPackage.path}: not a JSON object`) : null;
}
