import type { AssignPayload } from '@nathapp/fleet-protocol';
import { parsePrd } from '../prd';
import { assertFeature } from '../paths/safe-segment';
import { checkoutArgs, planBranch, validateBranchName } from './branch';
import type { Git } from './git';
import { resolveRef } from './refs';

export type CheckoutResult = { ok: true; branch: string | null; refSha: string } | { ok: false; reason: string };

export interface CheckoutInput {
  readonly git: Git;
  readonly repoDir: string;
  readonly assign: AssignPayload;
}

/** Design §2 steps 3-4 (R-3.3): RUN continues or creates `prd.branchName`; PLAN detaches at the ref. */
export async function prepareCheckout(input: CheckoutInput): Promise<CheckoutResult> {
  const { git, repoDir, assign } = input;
  const ref = await resolveRef(git, repoDir, assign.ref);
  if (!ref.ok) return { ok: false, reason: ref.reason === 'invalid' ? 'checkout: invalid ref' : 'checkout: ref not found' };
  if (assign.command === 'PLAN') {
    if ((await git.run(['cat-file', '-e', `${ref.sha}:.nax`], { cwd: repoDir })).code !== 0) return { ok: false, reason: 'no .nax dir' };
    await git.ok(['checkout', '--detach', ref.sha], { cwd: repoDir });
    return { ok: true, branch: null, refSha: ref.sha };
  }
  const feature = assertFeature(assign.feature);
  const prdText = await git.run(['show', `${ref.sha}:.nax/features/${feature}/prd.json`], { cwd: repoDir });
  if (prdText.code !== 0) return { ok: false, reason: 'checkout: no prd.json at ref' };
  const prd = parsePrd(prdText.stdout);
  if (!prd) return { ok: false, reason: 'checkout: prd.json is not valid JSON' };
  if (prd.branchName === null) return { ok: false, reason: 'checkout: prd.json has no branchName' };
  if (!(await validateBranchName(git, repoDir, prd.branchName, assign.repo.defaultBranch))) return { ok: false, reason: 'checkout: invalid branchName' };
  const action = await planBranch(git, repoDir, prd.branchName);
  const args = checkoutArgs(action, prd.branchName, ref.sha, false);
  if (!args) return { ok: false, reason: 'checkout: branch diverged' };
  await git.ok(args, { cwd: repoDir });
  return { ok: true, branch: prd.branchName, refSha: ref.sha };
}
