import { copyFile, mkdir, readdir, rename, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import type { GitIdentity } from '@nathapp/fleet-protocol';
import { featureDirFor } from '../paths/safe-segment';
import { checkoutArgs, planBranch, validateBranchName } from './branch';
import { NO_CREDENTIALS_REASON, isAuthFailure, type Git, GitError } from './git';

/**
 * D77: back-off before each retry of a failed PLAN push (so 3 pushes in all). A transient failure is recovered inside
 * the attempt; a requeue is a fresh lease that may land on another runner, so it re-plans rather than resuming.
 */
export const PLAN_PUSH_BACKOFF_MS: readonly number[] = [2_000, 8_000];
const realSleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** Design §2 step 8: never `plan/`, `sessions/` or `prd.rejected.json`. */
export const PLAN_ALLOWLIST = ['prd.json', 'spec.md', 'prd-fidelity-report.md', 'acceptance-meta.json'] as const;

async function present(dir: string, names: readonly string[]): Promise<string[]> {
  const have = new Set(await readdir(dir).catch(() => [] as string[]));
  return names.filter((name) => have.has(name));
}

const exists = (path: string): Promise<boolean> => stat(path).then(() => true, () => false);

/**
 * Copies the plan outputs out of the checkout so a branch switch cannot lose them (and the bundle can carry the logs).
 * Write-once (D61): the first stash is the source of truth. `checkout -f -B` overwrites a tracked stale `prd.json` in the
 * working tree, so a retry after a crash in that window must never read the checkout again. The stash is built in `.tmp`
 * siblings and renamed into place, `plan-out` last, so its existence means the stash is complete. A new attempt starts
 * from a wiped job directory (D53), which is what makes "once" safe.
 */
export async function stashPlanOutputs(repoDir: string, jobDir: string, feature: string): Promise<{ files: string[]; logs: string[] }> {
  const outDir = join(jobDir, 'plan-out');
  const logsDir = join(jobDir, 'plan-logs');
  if (await exists(outDir)) {
    return { files: await present(outDir, PLAN_ALLOWLIST), logs: (await readdir(logsDir).catch(() => [] as string[])).filter((name) => name.endsWith('.jsonl')) };
  }
  const dir = featureDirFor(repoDir, feature);
  const files = await present(dir, PLAN_ALLOWLIST);
  const logs = (await readdir(join(dir, 'plan')).catch(() => [] as string[])).filter((name) => name.endsWith('.jsonl'));
  if (files.length === 0 && logs.length === 0) return { files: [], logs: [] };
  const [outTmp, logsTmp] = [`${outDir}.tmp`, `${logsDir}.tmp`];
  await rm(outTmp, { recursive: true, force: true });
  await rm(logsTmp, { recursive: true, force: true });
  await mkdir(outTmp, { recursive: true });
  await mkdir(logsTmp, { recursive: true });
  for (const name of files) await copyFile(join(dir, name), join(outTmp, name));
  for (const name of logs) await copyFile(join(dir, 'plan', name), join(logsTmp, name));
  await rm(logsDir, { recursive: true, force: true });
  await rename(logsTmp, logsDir);
  await rename(outTmp, outDir);
  return { files, logs };
}

export interface PlanPushInput {
  readonly git: Git;
  readonly repoDir: string;
  readonly jobDir: string;
  readonly feature: string;
  readonly jobId: string;
  readonly branchName: string;
  readonly refSha: string;
  readonly defaultBranch: string;
  readonly identity: GitIdentity;
  readonly sleep?: (ms: number) => Promise<void>;
}

export type PlanPushResult = { ok: true; branch: string; sha: string; committed: boolean } | { ok: false; reason: string };

async function commitStep(input: PlanPushInput, files: readonly string[]): Promise<{ failure: string } | { committed: boolean }> {
  const { git, repoDir, feature, branchName, refSha } = input;
  const action = await planBranch(git, repoDir, branchName);
  const args = checkoutArgs(action, branchName, refSha, true);
  if (!args) return { failure: 'checkout: branch diverged' };
  await git.ok(args, { cwd: repoDir });
  const dir = featureDirFor(repoDir, feature);
  await mkdir(dir, { recursive: true });
  for (const name of files) await copyFile(join(input.jobDir, 'plan-out', name), join(dir, name));
  await git.ok(['add', '--', ...files.map((name) => `.nax/features/${feature}/${name}`)], { cwd: repoDir });
  const staged = await git.run(['diff', '--cached', '--quiet'], { cwd: repoDir });
  if (staged.code === 0) return { committed: false };
  if (staged.code !== 1) throw new GitError(['diff'], staged);
  const message = `chore(plan): ${feature} PRD via koda job ${input.jobId}`;
  // D69: the identity is passed explicitly, so a missing or different repo config cannot fail or alter the commit.
  const commit = ['-c', `user.name=${input.identity.name}`, '-c', `user.email=${input.identity.email}`, '-c', 'commit.gpgsign=false', 'commit', '--no-verify', '-q', '-m', message];
  await git.ok(commit, { cwd: repoDir });
  return { committed: true };
}

/** D77: `null` once the branch reached origin, else the failure reason. An auth failure is not retried. */
async function pushWithRetry(input: PlanPushInput): Promise<string | null> {
  const sleep = input.sleep ?? realSleep;
  for (let attempt = 0; ; attempt += 1) {
    const push = await input.git.run(['push', '--set-upstream', 'origin', input.branchName], { cwd: input.repoDir });
    if (push.code === 0) return null;
    if (isAuthFailure(push.stderr)) return NO_CREDENTIALS_REASON;
    const backoff = PLAN_PUSH_BACKOFF_MS[attempt];
    if (backoff === undefined) return 'plan push failed';
    await sleep(backoff);
  }
}

/**
 * Design §2 step 8 (R-3.4): the plan outputs go onto the PRD's `branchName` (checked out by the step 4 rules with
 * `checkout -f`), are committed as the assigned identity and pushed. Safe to run again after a crash (D52).
 */
export async function commitAndPushPlan(input: PlanPushInput): Promise<PlanPushResult> {
  const { git, repoDir, branchName } = input;
  if (!(await validateBranchName(git, repoDir, branchName, input.defaultBranch))) return { ok: false, reason: 'checkout: invalid branchName' };
  const { files } = await stashPlanOutputs(input.repoDir, input.jobDir, input.feature);   // write-once: a retry reads the first stash
  if (!files.includes('prd.json')) return { ok: false, reason: 'plan output missing' };
  let committed = false;
  try {
    const step = await commitStep(input, files);
    if ('failure' in step) return { ok: false, reason: step.failure };
    committed = step.committed;
  } catch {
    return { ok: false, reason: 'plan commit failed' };
  }
  const failure = await pushWithRetry(input);
  if (failure) return { ok: false, reason: failure };   // the commit stays on the local branch (D51 keep-local)
  const sha = (await git.ok(['rev-parse', 'HEAD'], { cwd: repoDir })).trim();
  return { ok: true, branch: branchName, sha, committed };
}
