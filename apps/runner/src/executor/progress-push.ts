import type { GitIdentity } from '@nathapp/fleet-protocol';
import { systemSleep } from '../time';
import type { Logger } from '../logger';
import { NO_CREDENTIALS_REASON, isAuthFailure, gitFailureFields, type Git } from './git';
import { PLAN_PUSH_BACKOFF_MS } from './plan-commit';

export type ProgressPushOutcome =
  | { readonly kind: 'pushed'; readonly branch: string; readonly sha: string }
  | { readonly kind: 'none'; readonly branch: string; readonly sha: string }
  | { readonly kind: 'failed'; readonly reason: string }
  | { readonly kind: 'halted' };

export interface ProgressPushInput {
  readonly git: Git;
  readonly repoDir: string;
  readonly feature: string;
  readonly jobId: string;
  readonly branchName: string;
  readonly identity: GitIdentity;
  readonly credentialHelper?: string | null;
  /** True after an ABANDON: stop before the next push attempt. A cancel never stops it (S1b §1.1). */
  readonly isHalted?: () => boolean;
  readonly sleep?: (ms: number) => Promise<void>;
  readonly log?: Logger;
}

const REASON_MAX = 200;
const REJECTED = /\[rejected\]|non-fast-forward|fetch first/i;

type Attempt = 'pushed' | 'none' | { readonly reason: string; readonly retry: boolean };

/** S1b §1.1 step 1: only the PRD is committed; nax's uncommitted story code and anything staged stay out. */
async function commitPrd(input: ProgressPushInput): Promise<void> {
  const { git, repoDir, feature } = input;
  const path = `.nax/features/${feature}/prd.json`;
  const dirty = await git.ok(['status', '--porcelain', '--', path], { cwd: repoDir });
  if (dirty.trim() === '') return;
  await git.ok(['add', '--', path], { cwd: repoDir });
  const message = `chore(nax): progress of ${feature} via koda job ${input.jobId}`;
  await git.ok([
    '-c', `user.name=${input.identity.name}`, '-c', `user.email=${input.identity.email}`, '-c', 'commit.gpgsign=false',
    'commit', '--no-verify', '-q', '-m', message, '--', path,
  ], {
    cwd: repoDir,
    // GIT_AUTHOR_*/GIT_COMMITTER_* env outrank `-c user.*`, so the job identity is repeated as env (D69).
    env: {
      GIT_AUTHOR_NAME: input.identity.name, GIT_AUTHOR_EMAIL: input.identity.email,
      GIT_COMMITTER_NAME: input.identity.name, GIT_COMMITTER_EMAIL: input.identity.email,
    },
  });
}

/** D142: porcelain push of exactly this branch; `=` means origin already has it. */
async function pushOnce(input: ProgressPushInput): Promise<Attempt> {
  const ref = `refs/heads/${input.branchName}`;
  const res = await input.git.run(['push', '--porcelain', 'origin', `${ref}:${ref}`], { cwd: input.repoDir, credentialHelper: input.credentialHelper ?? null });
  if (res.code === 0) return /^=\t/m.test(res.stdout) ? 'none' : 'pushed';
  if (REJECTED.test(`${res.stdout}\n${res.stderr}`)) return { reason: 'diverged', retry: false };
  if (isAuthFailure(res.stderr)) return { reason: NO_CREDENTIALS_REASON, retry: false };
  return { reason: 'push failed', retry: true };
}

/** S1b §1.1 (B5), #204: preserve unfinished or completed-without-finish RUN output on origin. Never forced. */
export async function pushProgress(input: ProgressPushInput): Promise<ProgressPushOutcome> {
  const { git, repoDir, branchName } = input;
  const head = (await git.run(['symbolic-ref', '--short', '-q', 'HEAD'], { cwd: repoDir })).stdout.trim();
  if (head !== branchName) return { kind: 'failed', reason: 'not on branch' };   // D143
  try {
    await commitPrd(input);
  } catch (error) {
    input.log?.warn('progress commit failed', { jobId: input.jobId, ...gitFailureFields(error) });
    return { kind: 'failed', reason: 'commit failed' };
  }
  const sleep = input.sleep ?? systemSleep;
  for (let attempt = 0; ; attempt += 1) {
    if (input.isHalted?.() === true) return { kind: 'halted' };
    const result = await pushOnce(input);
    // Both successful outcomes confirm origin has HEAD, including a retry after a lost push response.
    if (result === 'none' || result === 'pushed') return { kind: result, branch: branchName, sha: (await git.ok(['rev-parse', 'HEAD'], { cwd: repoDir })).trim() };
    const backoff = PLAN_PUSH_BACKOFF_MS[attempt];
    if (!result.retry || backoff === undefined) return { kind: 'failed', reason: result.reason };
    await sleep(backoff);
  }
}

/** The snapshot's `wipPush` value (S1b §1.1 "Result"). */
export function wipPushValue(outcome: Exclude<ProgressPushOutcome, { kind: 'halted' }>): string {
  if (outcome.kind === 'failed') return `failed:${outcome.reason.replace(/[^\x20-\x7e]/g, '?').slice(0, REASON_MAX) || 'unknown'}`;
  return outcome.kind;
}
