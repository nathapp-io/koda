import type { Git } from './git';

export type BranchAction = 'from-origin' | 'keep-local' | 'from-ref' | 'diverged';

const BRANCH_SHAPE = /^[A-Za-z0-9][A-Za-z0-9._/+@-]{0,254}$/;
const PROTECTED = new Set(['main', 'master']);

/** R-3.3 and D31: a PRD-supplied branch name must be a plain feature branch. */
export async function validateBranchName(git: Git, repoDir: string, name: string, defaultBranch: string): Promise<boolean> {
  if (!BRANCH_SHAPE.test(name) || name.includes('@{') || name.includes('..') || name.endsWith('.lock') || name.endsWith('/')) return false;
  if (name === defaultBranch || PROTECTED.has(name)) return false;
  return (await git.run(['check-ref-format', '--branch', name], { cwd: repoDir })).code === 0;
}

/**
 * Design §2 step 4. The design lists four cases; a branch that exists only locally (a run committed but never
 * pushed) is the fifth and is kept (D51), so a later run continues its commits.
 */
export async function planBranch(git: Git, repoDir: string, branch: string): Promise<BranchAction> {
  const has = async (ref: string): Promise<boolean> => (await git.run(['show-ref', '--verify', '--quiet', ref], { cwd: repoDir })).code === 0;
  const local = `refs/heads/${branch}`;
  const origin = `refs/remotes/origin/${branch}`;
  const [hasLocal, hasOrigin] = [await has(local), await has(origin)];
  if (!hasLocal && !hasOrigin) return 'from-ref';
  if (!hasOrigin) return 'keep-local';
  if (!hasLocal) return 'from-origin';
  const ancestor = async (a: string, b: string): Promise<boolean> => (await git.run(['merge-base', '--is-ancestor', a, b], { cwd: repoDir })).code === 0;
  if (await ancestor(origin, local)) return 'keep-local';
  return (await ancestor(local, origin)) ? 'from-origin' : 'diverged';
}

/** `force` is for the PLAN commit, where untracked plan files must not block the switch. `null` for a diverged branch. */
export function checkoutArgs(action: BranchAction, branch: string, refSha: string, force: boolean): string[] | null {
  const f = force ? ['-f'] : [];
  switch (action) {
    case 'from-origin': return ['checkout', ...f, '-B', branch, `origin/${branch}`];
    case 'keep-local': return ['checkout', ...f, branch, '--'];
    case 'from-ref': return ['checkout', ...f, '-B', branch, refSha];
    case 'diverged': return null;
  }
}
