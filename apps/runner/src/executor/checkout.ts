import type { AssignPayload } from '@nathapp/fleet-protocol';
import { parsePrd } from '../prd';
import { assertFeature } from '../paths/safe-segment';
import { checkoutArgs, planBranch, validateBranchName } from './branch';
import type { Git } from './git';
import { GIT_REF_RE, resolveRef } from './refs';

export type CheckoutResult = { ok: true; branch: string | null; refSha: string } | { ok: false; reason: string };

export interface CheckoutInput {
  readonly git: Git;
  readonly repoDir: string;
  readonly assign: AssignPayload;
}

/** US-005: the commit of the clone's local `refs/heads/<branch>`, or null when that branch does not exist. */
async function localBranchSha(git: Git, repoDir: string, branch: string): Promise<string | null> {
  if (!GIT_REF_RE.test(branch)) return null;
  const full = `refs/heads/${branch}`;
  if ((await git.run(['show-ref', '--verify', '--quiet', full], { cwd: repoDir })).code !== 0) return null;
  return (await git.ok(['rev-parse', '--verify', `${full}^{commit}`], { cwd: repoDir })).trim();
}

type LocalPlanBase = { kind: 'local'; sha: string } | { kind: 'origin' } | { kind: 'diverged' };

/**
 * US-005 + #409: a PLAN with `expectBranch` uses the clone's local branch only when it is equal to or ahead of
 * origin (a thread's re-published docs are local-only). A local branch behind origin (a flow's calls commit, written
 * by the API to origin only) yields to origin; a diverged one is refused, as the PLAN commit would refuse it.
 */
async function localPlanBase(git: Git, repoDir: string, branch: string): Promise<LocalPlanBase> {
  const localSha = await localBranchSha(git, repoDir, branch);
  if (localSha === null) return { kind: 'origin' };
  const origin = `refs/remotes/origin/${branch}`;
  if ((await git.run(['show-ref', '--verify', '--quiet', origin], { cwd: repoDir })).code !== 0) return { kind: 'local', sha: localSha };
  const ancestor = async (a: string, b: string): Promise<boolean> =>
    (await git.run(['merge-base', '--is-ancestor', a, b], { cwd: repoDir })).code === 0;
  if (await ancestor(origin, localSha)) return { kind: 'local', sha: localSha };
  return (await ancestor(localSha, origin)) ? { kind: 'origin' } : { kind: 'diverged' };
}

/** Design §2 steps 3-4 (R-3.3): RUN continues or creates `prd.branchName`; PLAN detaches at the ref. */
export async function prepareCheckout(input: CheckoutInput): Promise<CheckoutResult> {
  const { git, repoDir, assign } = input;
  const base = assign.command === 'PLAN' && assign.expectBranch !== undefined ? await localPlanBase(git, repoDir, assign.expectBranch) : null;
  if (base?.kind === 'diverged') return { ok: false, reason: 'checkout: branch diverged' };
  const localSha = base?.kind === 'local' ? base.sha : null;
  let refSha: string;
  if (localSha !== null) {
    refSha = localSha;
  } else {
    const ref = await resolveRef(git, repoDir, assign.ref);
    if (!ref.ok) return { ok: false, reason: ref.reason === 'invalid' ? 'checkout: invalid ref' : 'checkout: ref not found' };
    refSha = ref.sha;
  }
  if (assign.command === 'PLAN') {
    if ((await git.run(['cat-file', '-e', `${refSha}:.nax`], { cwd: repoDir })).code !== 0) return { ok: false, reason: 'no .nax dir' };
    await git.ok(['checkout', '--detach', refSha], { cwd: repoDir });
    return { ok: true, branch: null, refSha };
  }
  // fleet-agent-job US-007: an AGENT reviews nothing and produces no PRD — it runs against the ref itself, detached,
  // exactly like REVIEW and FIX, so no prd.json is read (and none is required at the ref).
  if (assign.command === 'REVIEW' || assign.command === 'FIX' || assign.command === 'AGENT') {
    await git.ok(['checkout', '--detach', refSha], { cwd: repoDir });
    return { ok: true, branch: null, refSha };
  }
  const feature = assertFeature(assign.feature);
  const prdText = await git.run(['show', `${refSha}:.nax/features/${feature}/prd.json`], { cwd: repoDir });
  if (prdText.code !== 0) return { ok: false, reason: 'checkout: no prd.json at ref' };
  const prd = parsePrd(prdText.stdout);
  if (!prd) return { ok: false, reason: 'checkout: prd.json is not valid JSON' };
  if (prd.branchName === null) return { ok: false, reason: 'checkout: prd.json has no branchName' };
  if (!(await validateBranchName(git, repoDir, prd.branchName, assign.repo.defaultBranch))) return { ok: false, reason: 'checkout: invalid branchName' };
  const action = await planBranch(git, repoDir, prd.branchName);
  const args = checkoutArgs(action, prd.branchName, refSha, false);
  if (!args) return { ok: false, reason: 'checkout: branch diverged' };
  await git.ok(args, { cwd: repoDir });
  return { ok: true, branch: prd.branchName, refSha };
}
