import type { Git } from './git';

/** The server's dispatch rule for `ref` (apps/api/src/fleet/jobs/dispatch-input.ts GIT_REF_RE), repeated: the runner does not trust the server. */
export const GIT_REF_RE = /^(?![-./])(?!.*\.\.)(?!.*\/\/)(?!.*\.lock$)(?!.*\/$)[A-Za-z0-9._/@+-]{1,255}$/;

export type RefResult =
  | { ok: true; sha: string; kind: 'remote-branch' | 'other' }
  | { ok: false; reason: 'invalid' | 'not-found' };

/** Design §2 step 3: origin/<ref> when that remote branch exists, else <ref> as a tag or commit. */
export async function resolveRef(git: Git, repoDir: string, ref: string): Promise<RefResult> {
  if (!GIT_REF_RE.test(ref)) return { ok: false, reason: 'invalid' };
  const remote = `refs/remotes/origin/${ref}`;
  if ((await git.run(['show-ref', '--verify', '--quiet', remote], { cwd: repoDir })).code === 0) {
    const sha = (await git.ok(['rev-parse', '--verify', `${remote}^{commit}`], { cwd: repoDir })).trim();
    return { ok: true, sha, kind: 'remote-branch' };
  }
  const other = await git.run(['rev-parse', '--verify', '--end-of-options', `${ref}^{commit}`], { cwd: repoDir });
  return other.code === 0 ? { ok: true, sha: other.stdout.trim(), kind: 'other' } : { ok: false, reason: 'not-found' };
}
