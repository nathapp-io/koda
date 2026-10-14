import { sanitizeDiagnostic } from '../../diagnostics';
import { errorMessage, firstLine } from '../../errors';
import { type Git, type GitOptions, type GitResult } from '../git';
import { resolveRef } from '../refs';
import { configBranchName } from './commit-push';

/** Each cleanup git call's own budget: the job's may already be spent (as on `timeout`). */
export const CLEANUP_TIMEOUT_MS = 30_000;

/** Every call gets the fixed budget, the nested ones resolveRef makes included (resolveRef has no timeout option). */
function bounded(git: Git): Git {
  const budget = (options: GitOptions): GitOptions => ({ ...options, timeoutMs: CLEANUP_TIMEOUT_MS });
  return { run: (args, options) => git.run(args, budget(options)), ok: (args, options) => git.ok(args, budget(options)) };
}

/** A failed call's reason: its first stderr line, sanitised (it reaches the job's step log). */
function failed(label: string, result: GitResult): string {
  return sanitizeDiagnostic(`${label}: ${firstLine(result.stderr) || `exit ${result.code}`}`);
}

/** `show-ref --verify --quiet`: 0 present, 1 absent; any other exit is an error, not an absence. */
async function refExists(git: Git, repoDir: string, ref: string): Promise<boolean> {
  const result = await git.run(['show-ref', '--verify', '--quiet', ref], { cwd: repoDir });
  if (result.code === 0) return true;
  if (result.code === 1) return false;
  throw new Error(failed(`show-ref ${ref}`, result));
}

/** Runs one step; a throw becomes that step's reason, so a failing step never stops the later ones. */
async function attempt(run: () => Promise<string | null>): Promise<string | null> {
  try {
    return await run();
  } catch (error) {
    return sanitizeDiagnostic(errorMessage(error));
  }
}

/**
 * Returns the shared config clone to the state before a config job touched it (US-002), after the job's outcome is
 * decided: HEAD detached at origin/<defaultBranch>, untracked files cleaned (no `-x`, so ignored files stay), the
 * job's local branch and its remote-tracking ref deleted. The branch on origin is the PR head and is never touched.
 * Null on success, otherwise the reasons of the failed steps. Never throws.
 */
export async function restoreConfigClone(git: Git, repoDir: string, defaultBranch: string, jobId: string): Promise<string | null> {
  const io = bounded(git);
  const failures: string[] = [];
  const record = (reason: string | null): void => {
    if (reason !== null) failures.push(reason);
  };
  const call = (args: readonly string[]): Promise<string | null> =>
    attempt(async () => {
      const result = await io.run(args, { cwd: repoDir });
      return result.code === 0 ? null : failed(args[0] ?? 'git', result);
    });
  const detachTo = (target: string): Promise<string | null> => call(['checkout', '-f', '--detach', target]);

  // 1-2: the default branch, detached. Whichever way it fails, HEAD is detached at its current commit instead.
  const restored = await attempt(async () => {
    const ref = await resolveRef(io, repoDir, defaultBranch);
    if (!ref.ok || ref.kind !== 'remote-branch') return 'origin default branch not found';
    return detachTo(ref.sha);
  });
  if (restored !== null) {
    record(restored);
    record(await detachTo('HEAD'));
  }
  // 3: untracked files; gitignored ones (checkpoint.jsonl and the like) survive.
  record(await call(['clean', '-ffd']));
  // 4: the job's own local branch, only when it exists (git refuses to delete a checked-out branch).
  record(await attempt(async () => {
    const branch = configBranchName(jobId);
    return (await refExists(io, repoDir, `refs/heads/${branch}`)) ? call(['branch', '-D', branch]) : null;
  }));
  // 5: the job's remote-tracking ref, only when it exists.
  record(await attempt(async () => {
    const remote = `refs/remotes/origin/${configBranchName(jobId)}`;
    return (await refExists(io, repoDir, remote)) ? call(['update-ref', '-d', remote]) : null;
  }));
  return failures.length === 0 ? null : failures.join('; ').slice(0, 300);
}
