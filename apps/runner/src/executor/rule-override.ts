import { chmod, mkdir, rm, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import type { RuleOverrideAssign } from '@nathapp/fleet-protocol';
import type { JobProfileContext } from './job-profile';

/**
 * fleet #370 (US-009): the rule override a repo carries travels with the ASSIGN and is materialized into the
 * job directory, never into the checkout: the job's own `.nax/` rules and context stay untouched.
 */
export const RULE_OVERRIDE_DIR = 'koda-rules';
/** The project context file, next to the rules directory in the job directory. */
export const RULE_CONTEXT_FILE = 'koda-context.md';

/** A path is inside the root when it is below it and names something of its own. */
const inside = (root: string, candidate: string): boolean => {
  const rel = relative(root, candidate);
  return rel !== '' && rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
};

/** The rules directory and every directory below it are private to the job (D93). */
const ensurePrivateDir = async (dir: string): Promise<void> => {
  await mkdir(dir, { recursive: true, mode: 0o700 });
  await chmod(dir, 0o700);
};

/**
 * Write the assigned rule override into the job directory and describe it for the per-job nax profile.
 *
 * The override's rules are written as files under `<jobDir>/koda-rules/`, laid out like `.nax/rules/`, and its
 * context as `<jobDir>/koda-context.md`. Everything of a previous attempt is removed first, so a job never runs
 * with a mixture of two overrides.
 *
 * Every destination is checked before anything is written: a rule path that resolves outside the rules directory
 * throws and leaves no file behind. The rules directory is removed and recreated, so a symlink inside it cannot
 * survive to carry a write out of the job directory.
 */
export async function materializeRuleOverride(jobDir: string, override: RuleOverrideAssign): Promise<JobProfileContext> {
  const overrideDir = resolve(jobDir, RULE_OVERRIDE_DIR);
  const contextFile = resolve(jobDir, RULE_CONTEXT_FILE);
  const destinations = override.rules.map((rule) => ({ rule, destination: resolve(overrideDir, rule.path) }));
  for (const { destination } of destinations) {
    if (!inside(overrideDir, destination)) throw new Error('rule override path');
  }
  await rm(overrideDir, { recursive: true, force: true });
  await rm(contextFile, { force: true });
  await ensurePrivateDir(overrideDir);
  for (const { rule, destination } of destinations) {
    await ensurePrivateDir(dirname(destination));
    await writeFile(destination, rule.content, { mode: 0o600 });
    await chmod(destination, 0o600);
  }
  if (override.context !== undefined) {
    await writeFile(contextFile, override.context.content, { mode: 0o600 });
    await chmod(contextFile, 0o600);
  }
  return {
    rules: { overrideDir, overrideMode: override.rulesMode },
    ...(override.context === undefined ? {} : { projectContext: { file: contextFile, mode: override.context.mode } }),
  };
}
