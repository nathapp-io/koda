import { appendFile } from 'node:fs/promises';
import { delimiter, join } from 'node:path';
import type { ConfigJobResult } from '@nathapp/fleet-protocol';
import type { CredentialProvider } from '../../credentials/broker';
import { withoutCredentialVars } from '../../credentials/credential-env';
import type { JobRow } from '../../journal/types';
import { reasonFromError, type Git } from '../git';
import type { ConfigJobContext, ConfigJobRun } from '../job-executor';
import { applyEdits } from './apply-edits';
import { commitAndPushConfig } from './commit-push';
import { changedFiles } from './drift';
import { openPullRequest } from './open-pr';
import { regenerate, type NaxRun } from './regenerate';
import { findConflicts } from './staleness';
import { trackedRun } from './subprocess';
import { DeadlineError, StoppedError, checkpoint, remainingMs, type ProcResult, type StepClock } from './types';
import { validateConfig } from './validate';

export interface ConfigJobDeps {
  readonly git: Git;
  readonly naxCommand: readonly string[];
  readonly naxHome: string;
  readonly credentials: CredentialProvider;
  readonly nowMs: () => number;
  /** The push back-off; tests inject a no-op. */
  readonly sleep?: (ms: number) => Promise<void>;
}

export interface ConfigJobDirs {
  readonly repoDir: string;
  readonly jobDir: string;
}

type Env = Readonly<Record<string, string | undefined>>;

const outcome = (result: ConfigJobResult, fields: { resultBranch?: string; resultSha?: string; resultPrUrl?: string } = {}): ConfigJobRun => ({ kind: 'result', result, ...fields });

/** The job's stdout / stderr streams (S2a log shipping) get every call's output, headed by the command. */
async function logCall(dirs: ConfigJobDirs, argv: readonly string[], result: ProcResult): Promise<void> {
  const head = `$ ${argv.join(' ')} (exit ${result.code})\n`;
  await appendFile(join(dirs.jobDir, 'nax.stdout'), `${head}${result.stdout}`);
  await appendFile(join(dirs.jobDir, 'nax.stderr'), `${head}${result.stderr}`);
}

/** gh / glab from the job's PATH, so the shim in `<jobDir>/bin` answers first (D88); a missing tool fails the call, not the job. */
const resolveTool = (argv: readonly string[], path: string): string[] => [Bun.which(argv[0] ?? '', { PATH: path }) ?? argv[0] ?? '', ...argv.slice(1)];

/**
 * S3 spec §5 steps 2-8 on a clone `prepareConfigJob` left detached at origin/<defaultBranch>. Never throws: a stop is
 * `stopped`, the deadline is outcome `timeout`, any other error is `failed` with a fixed-vocabulary reason.
 */
export async function runConfigJob(deps: ConfigJobDeps, job: JobRow, dirs: ConfigJobDirs, ctx: ConfigJobContext): Promise<ConfigJobRun> {
  const clock: StepClock = { nowMs: deps.nowMs, deadlineMs: ctx.deadlineMs, isStopped: ctx.isStopped };
  const { payload } = ctx;
  const { repoDir } = dirs;
  const { repo, gitIdentity } = job.assign;
  const inheritedPath = process.env['PATH'] ?? '';
  const naxEnv: Env = { ...withoutCredentialVars(process.env), NAX_GLOBAL_CONFIG_DIR: deps.naxHome, PATH: inheritedPath };
  const call = async (argv: readonly string[], env: Env): Promise<ProcResult> => {
    checkpoint(clock);
    const result = await trackedRun(argv, { cwd: repoDir, env, deadlineMs: ctx.deadlineMs, nowMs: deps.nowMs, isStopped: ctx.isStopped, onProcess: ctx.onProcess });
    await logCall(dirs, argv, result);
    return result;
  };
  const nax: NaxRun = (args) => call([...deps.naxCommand, ...args], naxEnv);
  try {
    checkpoint(clock);
    if (payload.mode === 'edit') {
      const conflicts = await findConflicts(deps.git, repoDir, payload.edits);
      if (conflicts.length > 0) return outcome({ outcome: 'conflict', files: conflicts });
      const applied = await applyEdits(repoDir, payload.edits);
      if (!applied.ok) return outcome({ outcome: 'invalid', output: applied.output });
      ctx.step(`applied ${payload.edits.length} edit(s)`);
    }
    const regenerated = await regenerate(nax, repoDir);
    if (!regenerated.ok) return outcome({ outcome: 'invalid', output: regenerated.output });
    ctx.step(regenerated.ran.length > 0 ? `regenerated: ${regenerated.ran.join(', ')}` : 'nothing to regenerate');
    if (payload.mode === 'drift') {
      const files = await changedFiles(deps.git, repoDir, remainingMs(clock));
      ctx.step(files.length > 0 ? `drift: ${files.length} file(s)` : 'no drift');
      return outcome({ outcome: 'drift', files });
    }
    const problem = await validateConfig(nax, repoDir, payload.edits);
    if (problem) return outcome(problem);
    ctx.step('validated');
    if (payload.prTitle === null) return { kind: 'failed', reason: 'config edit has no PR title' };
    checkpoint(clock);
    const acquired = await deps.credentials.acquire(job, { wait: true, isCancelled: ctx.isStopped });
    if (!acquired.ok) {
      if (acquired.cancelled) throw new StoppedError();
      return { kind: 'failed', reason: acquired.reason };
    }
    const pushed = await commitAndPushConfig({
      git: deps.git, repoDir, jobId: job.jobId, defaultBranch: repo.defaultBranch, title: payload.prTitle, identity: gitIdentity,
      credentialHelper: acquired.credentials.helper, timeoutMs: () => remainingMs(clock), ...(deps.sleep ? { sleep: deps.sleep } : {}),
    });
    if (pushed.kind === 'no_changes') {
      ctx.step('no changes to commit');
      return outcome({ outcome: 'no_changes' });
    }
    if (pushed.kind === 'push_failed') return outcome({ outcome: 'push_failed', output: pushed.output });
    ctx.step(`pushed ${pushed.branch}`);
    const { binDir } = acquired.credentials;
    const toolPath = binDir ? `${binDir}${delimiter}${inheritedPath}` : inheritedPath;
    const toolEnv: Env = { ...naxEnv, PATH: toolPath };
    const pr = await openPullRequest({
      run: (argv) => call(resolveTool(argv, toolPath), toolEnv), provider: repo.provider, repoSlug: `${repo.owner}/${repo.name}`,
      base: repo.defaultBranch, head: pushed.branch, title: payload.prTitle, body: payload.prBody,
    });
    const fields = { resultBranch: pushed.branch, resultSha: pushed.sha };
    if (!pr.ok) return outcome({ outcome: 'pr_failed', files: pushed.files, output: pr.output }, fields);
    ctx.step(`opened ${pr.url}`);
    return outcome({ outcome: 'ok', files: pushed.files }, { ...fields, resultPrUrl: pr.url });
  } catch (error) {
    if (error instanceof StoppedError) return { kind: 'stopped' };
    if (error instanceof DeadlineError) return outcome({ outcome: 'timeout' });
    return { kind: 'failed', reason: reasonFromError(error) };
  }
}
