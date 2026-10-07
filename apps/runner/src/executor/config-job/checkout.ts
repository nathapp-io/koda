import type { Git } from '../git';
import { resolveRef } from '../refs';

/** D480: the latest default branch, detached; `-f` drops whatever a previous job left in the shared clone. */
export async function prepareConfigCheckout(git: Git, repoDir: string, defaultBranch: string): Promise<{ ok: true; sha: string } | { ok: false; reason: string }> {
  const ref = await resolveRef(git, repoDir, defaultBranch);
  if (!ref.ok || ref.kind !== 'remote-branch') return { ok: false, reason: 'checkout: default branch not found' };
  await git.ok(['checkout', '-f', '--detach', ref.sha], { cwd: repoDir });
  return { ok: true, sha: ref.sha };
}
