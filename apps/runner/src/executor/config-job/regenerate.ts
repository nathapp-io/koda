import { stat } from 'node:fs/promises';
import { join } from 'node:path';
import { sanitizeDiagnostic } from '../../diagnostics';
import { raiseIfInterrupted, type ProcResult } from './types';

/** One nax call in the job's clone, with the job's env and deadline already bound (D484). */
export type NaxRun = (args: readonly string[]) => Promise<ProcResult>;

const exists = (path: string): Promise<boolean> => stat(path).then(() => true, () => false);

/** What the job page shows for a failed nax call: the command (never the runner's clone path), the exit code, stderr then stdout. */
export function describeFailure(label: string, result: ProcResult): string {
  return sanitizeDiagnostic(`$ ${label} (exit ${result.code})\n${result.stderr}${result.stdout}`);
}

async function hasPackageContext(repoDir: string): Promise<boolean> {
  const mono = join(repoDir, '.nax', 'mono');
  if (!(await exists(mono))) return false;
  for await (const _found of new Bun.Glob('**/context.md').scan({ cwd: mono, onlyFiles: true, followSymlinks: false })) return true;
  return false;
}

/**
 * S3 spec §5 step 4: root files when `.nax/context.md` exists, package files when any `.nax/mono/**\/context.md`
 * exists (`--all-packages` writes package files only, so both calls are needed); neither: nothing to regenerate.
 */
export async function regenerate(nax: NaxRun, repoDir: string): Promise<{ ok: true; ran: string[] } | { ok: false; output: string }> {
  const steps: Array<{ label: string; args: string[] }> = [];
  if (await exists(join(repoDir, '.nax', 'context.md'))) steps.push({ label: 'generate', args: ['generate', '-d', repoDir] });
  if (await hasPackageContext(repoDir)) steps.push({ label: 'generate --all-packages', args: ['generate', '--all-packages', '-d', repoDir] });
  const ran: string[] = [];
  for (const step of steps) {
    const result = await nax(step.args);
    raiseIfInterrupted(result);
    if (result.code !== 0) return { ok: false, output: describeFailure(`nax ${step.label}`, result) };
    ran.push(step.label);
  }
  return { ok: true, ran };
}
