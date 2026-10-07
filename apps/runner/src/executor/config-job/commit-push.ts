import type { GitIdentity } from '@nathapp/fleet-protocol';
import { sanitizeDiagnostic } from '../../diagnostics';
import { assertSegment } from '../../paths/safe-segment';
import { systemSleep } from '../../time';
import { validateBranchName } from '../branch';
import { NO_CREDENTIALS_REASON, isAuthFailure, type Git } from '../git';
import { PLAN_PUSH_BACKOFF_MS } from '../plan-commit';

export const CONFIG_BRANCH_PREFIX = 'nax-config/';

export const configBranchName = (jobId: string): string => `${CONFIG_BRANCH_PREFIX}${assertSegment('jobId', jobId)}`;

export interface ConfigPushInput {
  readonly git: Git;
  readonly repoDir: string;
  readonly jobId: string;
  readonly defaultBranch: string;
  readonly title: string;
  readonly identity: GitIdentity;
  readonly credentialHelper: string | null;
  /** What is left of the job's budget, re-read for every git call. */
  readonly timeoutMs: () => number;
  readonly sleep?: (ms: number) => Promise<void>;
}

export type ConfigPushResult =
  | { kind: 'pushed'; branch: string; sha: string; files: string[] }
  | { kind: 'no_changes' }
  | { kind: 'push_failed'; output: string };

/** D487: `--force` onto the job's own branch; D77's back-off; an auth failure is not retried. */
async function pushWithRetry(input: ConfigPushInput, branch: string): Promise<string | null> {
  const sleep = input.sleep ?? systemSleep;
  for (let attempt = 0; ; attempt += 1) {
    const push = await input.git.run(['push', '--force', 'origin', `HEAD:refs/heads/${branch}`], { cwd: input.repoDir, credentialHelper: input.credentialHelper, timeoutMs: input.timeoutMs() });
    if (push.code === 0) return null;
    if (isAuthFailure(push.stderr)) return NO_CREDENTIALS_REASON;
    const backoff = PLAN_PUSH_BACKOFF_MS[attempt];
    if (backoff === undefined) return sanitizeDiagnostic(`git push failed: ${push.stderr.trim()}`).slice(0, 2_000);
    await sleep(backoff);
  }
}

/** S3 spec §5 step 7: everything the edit and `nax generate` changed, on `nax-config/<jobId>`, as the assigned identity. */
export async function commitAndPushConfig(input: ConfigPushInput): Promise<ConfigPushResult> {
  const { git, repoDir } = input;
  const at = () => ({ cwd: repoDir, timeoutMs: input.timeoutMs() });
  await git.ok(['add', '-A'], at());
  const files = (await git.ok(['diff', '--cached', '--name-only', '-z'], at())).split('\0').filter(Boolean).sort();
  if (files.length === 0) return { kind: 'no_changes' };
  const branch = configBranchName(input.jobId);
  if (!(await validateBranchName(git, repoDir, branch, input.defaultBranch))) throw new Error(`invalid config branch ${branch}`);
  await git.ok(['checkout', '-B', branch], at());
  const { name, email } = input.identity;
  // D69: the identity is passed explicitly, so the clone's config cannot fail or alter the commit.
  await git.ok(['-c', `user.name=${name}`, '-c', `user.email=${email}`, '-c', 'commit.gpgsign=false', 'commit', '--no-verify', '-q', '-m', input.title], {
    ...at(), env: { GIT_AUTHOR_NAME: name, GIT_AUTHOR_EMAIL: email, GIT_COMMITTER_NAME: name, GIT_COMMITTER_EMAIL: email },
  });
  const failure = await pushWithRetry(input, branch);
  if (failure) return { kind: 'push_failed', output: failure };
  return { kind: 'pushed', branch, sha: (await git.ok(['rev-parse', 'HEAD'], at())).trim(), files };
}
