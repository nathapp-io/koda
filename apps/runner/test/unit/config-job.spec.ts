import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { readFile, stat, writeFile } from 'node:fs/promises';
import { delimiter, join } from 'node:path';
import type { AssignPayload, ConfigEditPayload } from '@nathapp/fleet-protocol';
import { CLEANUP_TIMEOUT_MS, restoreConfigClone } from '../../src/executor/config-job/cleanup';
import type { ConfigJobContext } from '../../src/executor/job-executor';
import { HostExecutor } from '../../src/executor/host-executor';
import { createGit, GitError, type Git, type GitOptions, type GitResult } from '../../src/executor/git';
import type { ProcessInfo } from '../../src/executor/pid-registry';
import { Journal } from '../../src/journal/journal';
import type { JobRow } from '../../src/journal/types';
import { createMemoryLogger } from '../../src/logger';
import { jobDirFor } from '../../src/paths/safe-segment';
import { assignFor } from '../helpers/assign';
import { installFakeGh } from '../helpers/fake-gh';
import { git as sh, isolateGit, makeOrigin } from '../helpers/git-fixture';
import { NO_APPROVALS } from '../helpers/no-approvals';
import { NO_CREDENTIALS } from '../helpers/no-credentials';
import { makeTempDirs } from '../helpers/tmp';

const tmp = makeTempDirs();
const FAKE = join(import.meta.dir, '..', 'fixtures', 'fake-nax.ts');
const SEED = { 'README.md': 'x\n', '.nax/context.md': '# ctx\n', '.nax/rules/a.md': '# a\n', '.nax/config.json': '{}\n' };
let ghLog = '';
const savedPath = process.env['PATH'];
beforeAll(async () => {
  isolateGit();
  const gh = await installFakeGh(await tmp.make('gh'));
  ghLog = gh.logPath;
  process.env['PATH'] = `${gh.binDir}${delimiter}${savedPath ?? ''}`;
  process.env['FAKE_GH_LOG'] = gh.logPath;
});
afterAll(async () => {
  process.env['PATH'] = savedPath;
  for (const k of ['FAKE_GH_LOG', 'FAKE_GH_CREATE_EXIT', 'FAKE_NAX_GENERATE_SLEEP_MS']) delete process.env[k];
  await tmp.cleanup();
});

/** The process lookups for a world: built from its clone directory, so a fake can report the clone path in argv. */
type ProcessInfoFor = (repoDir: string) => ProcessInfo;

/** `git` overrides the real Git of the unit world (a fault-injecting one, in the US-002 tests). */
async function world(command: 'CONFIG_EDIT' | 'CONFIG_DRIFT', files: Record<string, string> = SEED, processInfo?: ProcessInfoFor, git?: Git) {
  const base = await tmp.make('cfg-host');
  const origin = await makeOrigin(base, 'origin', { files });
  const workspaceRoot = join(base, 'ws');
  const assign: AssignPayload = assignFor(command, { jobId: 'cjob1', repo: { provider: 'github', owner: 'acme', name: 'app', defaultBranch: 'main', cloneUrl: origin.url } });
  const journal = Journal.open(':memory:');
  const row: JobRow = journal.insertJob({ assign, leaseEpoch: 1, repoKey: 'acme/app', jobDir: jobDirFor(workspaceRoot, 'cjob1') }).row;
  const ex = new HostExecutor({
    config: { workspaceRoot, naxCommand: ['bun', FAKE], naxHome: join(base, 'naxhome') }, git: git ?? createGit(), log: createMemoryLogger(),
    nowMs: () => Date.now(), sleep: async () => undefined, credentials: NO_CREDENTIALS, approvals: NO_APPROVALS,
    ...(processInfo ? { processInfo: processInfo(join(workspaceRoot, 'acme', 'app')) } : {}),
  });
  const repoDir = join(workspaceRoot, 'acme', 'app');
  const blob = (path: string) => sh(origin.dir, 'rev-parse', `main:${path}`);
  const head = () => sh(origin.dir, 'rev-parse', 'main');
  const steps: string[] = [];
  const procs: Array<{ pid: number; pgid: number } | null> = [];
  const ctx = (payload: ConfigEditPayload, over: Partial<ConfigJobContext> = {}): ConfigJobContext => ({
    payload, deadlineMs: Date.now() + 60_000, isStopped: () => false, onProcess: (p) => { procs.push(p); }, step: (m) => { steps.push(m); }, ...over,
  });
  return { base, origin, repoDir, row, ex, blob, head, ctx, steps, procs };
}
const branchOnOrigin = (w: { origin: { dir: string } }) => sh(w.origin.dir, 'rev-parse', '--verify', 'nax-config/cjob1').then(() => true, () => false);

/** A Git over one `run`: `ok` throws on a non-zero exit, as `createGit` does. */
function gitFrom(run: Git['run']): Git {
  return {
    run,
    ok: async (args, options) => {
      const result = await run(args, options);
      if (result.code !== 0) throw new GitError(args, result);
      return result.stdout;
    },
  };
}

/**
 * A real Git that fails each call `shouldFail` names, once `arm()` is called (after prepare, so the pre-job checkout is
 * real). `fired()` counts the injected failures, so a test can prove the fault was reached.
 */
function faultyGit(shouldFail: (args: readonly string[]) => boolean): { git: Git; arm: () => void; fired: () => number } {
  const real = createGit();
  let armed = false;
  let hits = 0;
  const run: Git['run'] = (args, options) => {
    if (armed && shouldFail(args)) {
      hits += 1;
      return Promise.resolve({ code: 1, stdout: '', stderr: 'injected fault' });
    }
    return real.run(args, options);
  };
  return { git: gitFrom(run), arm: () => { armed = true; }, fired: () => hits };
}

/** A real Git that records the timeout of every call. */
function recordingGit(): { git: Git; timeouts: Array<number | undefined> } {
  const real = createGit();
  const timeouts: Array<number | undefined> = [];
  const run: Git['run'] = (args, options) => {
    timeouts.push(options.timeoutMs);
    return real.run(args, options);
  };
  return { git: gitFrom(run), timeouts };
}

const detached = (dir: string): Promise<boolean> => sh(dir, 'symbolic-ref', '-q', 'HEAD').then(() => false, () => true);
const refExists = (dir: string, ref: string): Promise<boolean> => sh(dir, 'show-ref', '--verify', '--quiet', ref).then(() => true, () => false);
const fileExists = (path: string): Promise<boolean> => stat(path).then(() => true, () => false);
const JOB_BRANCH = 'refs/heads/nax-config/cjob1';
const JOB_REMOTE_REF = 'refs/remotes/origin/nax-config/cjob1';
const DEFAULT_REMOTE_REF = 'refs/remotes/origin/main';

/** An ok edit job, run through HostExecutor.runConfigJob on a fresh clone. */
async function okEdit(git?: Git) {
  const w = await world('CONFIG_EDIT', SEED, undefined, git);
  await w.ex.prepareConfigJob(w.row);
  const run = await w.ex.runConfigJob(w.row, w.ctx({
    mode: 'edit', baseSha: await w.head(), prTitle: 'Tighten rule a', prBody: 'Because',
    edits: [{ path: '.nax/rules/a.md', op: 'put', content: '# a tightened\n', baseSha: await w.blob('.nax/rules/a.md') }],
  }));
  return { w, run };
}

describe('config clone restored after the run (US-002)', () => {
  test('AC-1: an ok edit job leaves HEAD detached at the origin default-branch commit', async () => {
    const { w, run } = await okEdit();
    expect(run).toMatchObject({ kind: 'result', result: { outcome: 'ok' } });
    expect(await detached(w.repoDir)).toBe(true);
    expect(await sh(w.repoDir, 'rev-parse', 'HEAD')).toBe(await w.head());
  });

  test('AC-2: an ok edit job leaves no local nax-config/<jobId> branch', async () => {
    const { w, run } = await okEdit();
    expect(run).toMatchObject({ kind: 'result', result: { outcome: 'ok' } });
    expect(await refExists(w.repoDir, JOB_BRANCH)).toBe(false);
  });

  test('AC-3: an ok edit job leaves no refs/remotes/origin/nax-config/<jobId> ref', async () => {
    const { w, run } = await okEdit();
    expect(run).toMatchObject({ kind: 'result', result: { outcome: 'ok' } });
    expect(await refExists(w.repoDir, JOB_REMOTE_REF)).toBe(false);
  });

  test('AC-4: an ok edit job leaves the branch on origin at the resultSha (the PR head)', async () => {
    const { w, run } = await okEdit();
    expect(run).toMatchObject({ kind: 'result', result: { outcome: 'ok' }, resultBranch: 'nax-config/cjob1' });
    expect(await sh(w.origin.dir, 'rev-parse', '--verify', 'refs/heads/nax-config/cjob1')).toBe((run as { resultSha: string }).resultSha);
  });

  test('AC-5: a pr_failed edit job leaves no local branch and keeps resultBranch', async () => {
    const w = await world('CONFIG_EDIT');
    await w.ex.prepareConfigJob(w.row);
    process.env['FAKE_GH_CREATE_EXIT'] = '1';
    try {
      const run = await w.ex.runConfigJob(w.row, w.ctx({ mode: 'regenerate', baseSha: await w.head(), prTitle: 'R', prBody: null, edits: [] }));
      expect(run).toMatchObject({ kind: 'result', result: { outcome: 'pr_failed' }, resultBranch: 'nax-config/cjob1' });
      expect(await refExists(w.repoDir, JOB_BRANCH)).toBe(false);
    } finally {
      delete process.env['FAKE_GH_CREATE_EXIT'];
    }
  });

  test('AC-6: an invalid edit job leaves HEAD detached at origin/<defaultBranch> and the rejected file absent', async () => {
    const w = await world('CONFIG_EDIT');
    await w.ex.prepareConfigJob(w.row);
    const run = await w.ex.runConfigJob(w.row, w.ctx({
      mode: 'edit', baseSha: await w.head(), prTitle: 'T', prBody: null,
      edits: [{ path: '.nax/rules/bad.md', op: 'put', content: 'FAKE_LINT_FAIL', baseSha: null }],
    }));
    expect(run).toMatchObject({ kind: 'result', result: { outcome: 'invalid' } });
    expect(await detached(w.repoDir)).toBe(true);
    expect(await sh(w.repoDir, 'rev-parse', 'HEAD')).toBe(await w.head());
    expect(await fileExists(join(w.repoDir, '.nax', 'rules', 'bad.md'))).toBe(false);
  });

  test('AC-7: an untracked file written before a conflict is removed and HEAD is detached at origin/<defaultBranch>', async () => {
    const w = await world('CONFIG_EDIT');
    await w.ex.prepareConfigJob(w.row);
    await writeFile(join(w.repoDir, '.nax', 'rules', 'stray.md'), '# stray\n');
    const run = await w.ex.runConfigJob(w.row, w.ctx({
      mode: 'edit', baseSha: await w.head(), prTitle: 'T', prBody: null,
      edits: [{ path: '.nax/rules/a.md', op: 'put', content: 'mine', baseSha: 'f'.repeat(40) }],
    }));
    expect(run).toMatchObject({ kind: 'result', result: { outcome: 'conflict' } });
    expect(await fileExists(join(w.repoDir, '.nax', 'rules', 'stray.md'))).toBe(false);
    expect(await detached(w.repoDir)).toBe(true);
    expect(await sh(w.repoDir, 'rev-parse', 'HEAD')).toBe(await w.head());
  });

  test('AC-8: a job stopped after its edits were applied leaves the edited file at its origin default-branch content', async () => {
    const w = await world('CONFIG_EDIT');
    await w.ex.prepareConfigJob(w.row);
    process.env['FAKE_NAX_GENERATE_SLEEP_MS'] = '20000';
    try {
      let stop = false;
      setTimeout(() => { stop = true; }, 500);
      const run = await w.ex.runConfigJob(w.row, w.ctx({
        mode: 'edit', baseSha: await w.head(), prTitle: 'T', prBody: null,
        edits: [{ path: '.nax/rules/a.md', op: 'put', content: '# a tightened\n', baseSha: await w.blob('.nax/rules/a.md') }],
      }, { isStopped: () => stop }));
      expect(run).toEqual({ kind: 'stopped' });
      expect((await readFile(join(w.repoDir, '.nax', 'rules', 'a.md'), 'utf8')).trim()).toBe(await sh(w.origin.dir, 'show', 'main:.nax/rules/a.md'));
    } finally {
      delete process.env['FAKE_NAX_GENERATE_SLEEP_MS'];
    }
  });

  test('AC-9: a gitignored file in the clone survives an invalid edit job', async () => {
    const w = await world('CONFIG_EDIT', { ...SEED, '.gitignore': 'ignored.log\n' });
    await w.ex.prepareConfigJob(w.row);
    await writeFile(join(w.repoDir, 'ignored.log'), 'keep me\n');
    const run = await w.ex.runConfigJob(w.row, w.ctx({
      mode: 'edit', baseSha: await w.head(), prTitle: 'T', prBody: null,
      edits: [{ path: '.nax/rules/bad.md', op: 'put', content: 'FAKE_LINT_FAIL', baseSha: null }],
    }));
    expect(run).toMatchObject({ kind: 'result', result: { outcome: 'invalid' } });
    expect(await readFile(join(w.repoDir, 'ignored.log'), 'utf8')).toBe('keep me\n');
  });

  test('AC-10: an ok edit job still succeeds when the restoring checkout to origin/<defaultBranch> fails', async () => {
    let target = '';
    const fault = faultyGit((args) => args[0] === 'checkout' && args[1] === '-f' && args[2] === '--detach' && args[3] === target);
    const w = await world('CONFIG_EDIT', SEED, undefined, fault.git);
    await w.ex.prepareConfigJob(w.row);
    target = await w.head();
    fault.arm();
    const run = await w.ex.runConfigJob(w.row, w.ctx({
      mode: 'edit', baseSha: await w.head(), prTitle: 'Tighten rule a', prBody: 'Because',
      edits: [{ path: '.nax/rules/a.md', op: 'put', content: '# a tightened\n', baseSha: await w.blob('.nax/rules/a.md') }],
    }));
    expect(run).toMatchObject({ kind: 'result', result: { outcome: 'ok', files: ['.nax/rules/a.md', 'AGENTS.md', 'CLAUDE.md'] }, resultPrUrl: 'https://example.test/koda/pull/7' });
    expect(fault.fired()).toBeGreaterThan(0);
  });

  test('AC-11: the failed restoring checkout is reported as a cleanup failure', async () => {
    let target = '';
    const fault = faultyGit((args) => args[0] === 'checkout' && args[1] === '-f' && args[2] === '--detach' && args[3] === target);
    const w = await world('CONFIG_EDIT', SEED, undefined, fault.git);
    await w.ex.prepareConfigJob(w.row);
    target = await w.head();
    fault.arm();
    await w.ex.runConfigJob(w.row, w.ctx({
      mode: 'edit', baseSha: await w.head(), prTitle: 'Tighten rule a', prBody: 'Because',
      edits: [{ path: '.nax/rules/a.md', op: 'put', content: '# a tightened\n', baseSha: await w.blob('.nax/rules/a.md') }],
    }));
    expect(fault.fired()).toBeGreaterThan(0);
    expect(w.steps.some((step) => step.startsWith('cleanup failed:'))).toBe(true);
  });

  test('AC-12: after the failed restoring checkout the clone is detached and the local job branch is deleted', async () => {
    let target = '';
    const fault = faultyGit((args) => args[0] === 'checkout' && args[1] === '-f' && args[2] === '--detach' && args[3] === target);
    const w = await world('CONFIG_EDIT', SEED, undefined, fault.git);
    await w.ex.prepareConfigJob(w.row);
    target = await w.head();
    fault.arm();
    await w.ex.runConfigJob(w.row, w.ctx({
      mode: 'edit', baseSha: await w.head(), prTitle: 'Tighten rule a', prBody: 'Because',
      edits: [{ path: '.nax/rules/a.md', op: 'put', content: '# a tightened\n', baseSha: await w.blob('.nax/rules/a.md') }],
    }));
    expect(await detached(w.repoDir)).toBe(true);
    expect(await refExists(w.repoDir, JOB_BRANCH)).toBe(false);
  });

  test('AC-13: restoreConfigClone with origin/<defaultBranch> deleted reports a reason, detaches HEAD and deletes the job branch', async () => {
    const w = await world('CONFIG_EDIT');
    await w.ex.prepareConfigJob(w.row);
    await sh(w.repoDir, 'checkout', '-q', '-B', 'nax-config/cjob1');
    await sh(w.repoDir, 'update-ref', '-d', DEFAULT_REMOTE_REF);
    const reason = await restoreConfigClone(createGit(), w.repoDir, 'main', 'cjob1');
    expect(reason).not.toBeNull();
    expect(await detached(w.repoDir)).toBe(true);
    expect(await refExists(w.repoDir, JOB_BRANCH)).toBe(false);
  });

  test('every cleanup git call gets the fixed CLEANUP_TIMEOUT_MS budget', async () => {
    const w = await world('CONFIG_EDIT');
    await w.ex.prepareConfigJob(w.row);
    await sh(w.repoDir, 'checkout', '-q', '-B', 'nax-config/cjob1');
    const recorder = recordingGit();
    expect(await restoreConfigClone(recorder.git, w.repoDir, 'main', 'cjob1')).toBeNull();
    expect(recorder.timeouts.length).toBeGreaterThan(0);
    expect(recorder.timeouts.every((timeout) => timeout === CLEANUP_TIMEOUT_MS)).toBe(true);
    expect(CLEANUP_TIMEOUT_MS).toBe(30_000);
  });
});

describe('HostExecutor config jobs (S3 §5)', () => {
  test('edit: staleness ok, apply, regenerate, validate, commit, push, PR', async () => {
    const w = await world('CONFIG_EDIT');
    expect(await w.ex.prepareConfigJob(w.row)).toEqual({ ok: true, branch: null });
    const run = await w.ex.runConfigJob(w.row, w.ctx({
      mode: 'edit', baseSha: await w.head(), prTitle: 'Tighten rule a', prBody: 'Because',
      edits: [{ path: '.nax/rules/a.md', op: 'put', content: '# a tightened\n', baseSha: await w.blob('.nax/rules/a.md') }],
    }));
    expect(run).toEqual({
      kind: 'result', result: { outcome: 'ok', files: ['.nax/rules/a.md', 'AGENTS.md', 'CLAUDE.md'] },
      resultBranch: 'nax-config/cjob1', resultSha: await sh(w.origin.dir, 'rev-parse', 'nax-config/cjob1'), resultPrUrl: 'https://example.test/koda/pull/7',
    });
    expect(await sh(w.origin.dir, 'show', 'nax-config/cjob1:.nax/rules/a.md')).toBe('# a tightened');
    const gh = (await readFile(ghLog, 'utf8')).trim().split('\n').map((line) => JSON.parse(line) as { argv: string[] }).at(-1);
    expect(gh?.argv).toEqual(['pr', 'create', '--repo', 'acme/app', '--base', 'main', '--head', 'nax-config/cjob1', '--title', 'Tighten rule a', '--body', 'Because']);
    expect(w.steps).toEqual(expect.arrayContaining(['applied 1 edit(s)', 'regenerated: generate', 'validated', 'pushed nax-config/cjob1', 'opened https://example.test/koda/pull/7']));
    expect(w.procs.length).toBeGreaterThan(0);
    expect(w.procs.at(-1)).toBeNull();
  });
  test('edit: a file changed upstream since it was loaded is a conflict; nothing is pushed', async () => {
    const w = await world('CONFIG_EDIT');
    await w.ex.prepareConfigJob(w.row);
    const run = await w.ex.runConfigJob(w.row, w.ctx({
      mode: 'edit', baseSha: await w.head(), prTitle: 'T', prBody: null,
      edits: [{ path: '.nax/rules/a.md', op: 'put', content: 'mine', baseSha: 'f'.repeat(40) }],
    }));
    expect(run).toEqual({ kind: 'result', result: { outcome: 'conflict', files: ['.nax/rules/a.md'] } });
    expect(await branchOnOrigin(w)).toBe(false);
  });
  test('edit: a rule nax lint rejects is invalid; nothing is pushed', async () => {
    const w = await world('CONFIG_EDIT');
    await w.ex.prepareConfigJob(w.row);
    const run = await w.ex.runConfigJob(w.row, w.ctx({
      mode: 'edit', baseSha: await w.head(), prTitle: 'T', prBody: null,
      edits: [{ path: '.nax/rules/bad.md', op: 'put', content: 'FAKE_LINT_FAIL', baseSha: null }],
    }));
    expect(run).toMatchObject({ kind: 'result', result: { outcome: 'invalid' } });
    expect((run as { result: { output: string } }).result.output).toContain('banned marker FAKE_LINT_FAIL');
    expect(await branchOnOrigin(w)).toBe(false);
  });
  test('drift: lists the generated files nax would change, pushes nothing', async () => {
    const w = await world('CONFIG_DRIFT');
    await w.ex.prepareConfigJob(w.row);
    const run = await w.ex.runConfigJob(w.row, w.ctx({ mode: 'drift', baseSha: await w.head(), prTitle: null, prBody: null, edits: [] }));
    expect(run).toEqual({ kind: 'result', result: { outcome: 'drift', files: ['AGENTS.md', 'CLAUDE.md'] } });
    expect(await branchOnOrigin(w)).toBe(false);
  });
  test('regenerate on an up-to-date repo is no_changes', async () => {
    const generated = '<!-- generated by fake nax -->\n# ctx\n';
    const w = await world('CONFIG_EDIT', { ...SEED, 'CLAUDE.md': generated, 'AGENTS.md': generated });
    await w.ex.prepareConfigJob(w.row);
    const run = await w.ex.runConfigJob(w.row, w.ctx({ mode: 'regenerate', baseSha: await w.head(), prTitle: 'Regenerate', prBody: null, edits: [] }));
    expect(run).toEqual({ kind: 'result', result: { outcome: 'no_changes' } });
  });
  test('a failed PR keeps the pushed branch in the result', async () => {
    const w = await world('CONFIG_EDIT');
    await w.ex.prepareConfigJob(w.row);
    process.env['FAKE_GH_CREATE_EXIT'] = '1';
    try {
      const run = await w.ex.runConfigJob(w.row, w.ctx({ mode: 'regenerate', baseSha: await w.head(), prTitle: 'R', prBody: null, edits: [] }));
      expect(run).toMatchObject({ kind: 'result', result: { outcome: 'pr_failed', files: ['AGENTS.md', 'CLAUDE.md'] }, resultBranch: 'nax-config/cjob1' });
      expect((run as { result: { output: string } }).result.output).toContain('open the PR by hand');
    } finally {
      delete process.env['FAKE_GH_CREATE_EXIT'];
    }
  });
  test('a stop during a slow nax call ends the run as stopped', async () => {
    const w = await world('CONFIG_DRIFT');
    await w.ex.prepareConfigJob(w.row);
    process.env['FAKE_NAX_GENERATE_SLEEP_MS'] = '20000';
    try {
      let stop = false;
      setTimeout(() => { stop = true; }, 500);
      const started = Date.now();
      const run = await w.ex.runConfigJob(w.row, w.ctx({ mode: 'drift', baseSha: await w.head(), prTitle: null, prBody: null, edits: [] }, { isStopped: () => stop }));
      expect(run).toEqual({ kind: 'stopped' });
      expect(Date.now() - started).toBeLessThan(8_000);
    } finally {
      delete process.env['FAKE_NAX_GENERATE_SLEEP_MS'];
    }
  });
  test('the deadline ends the run as timeout', async () => {
    const w = await world('CONFIG_DRIFT');
    await w.ex.prepareConfigJob(w.row);
    process.env['FAKE_NAX_GENERATE_SLEEP_MS'] = '20000';
    try {
      const run = await w.ex.runConfigJob(w.row, w.ctx({ mode: 'drift', baseSha: await w.head(), prTitle: null, prBody: null, edits: [] }, { deadlineMs: Date.now() + 800 }));
      expect(run).toEqual({ kind: 'result', result: { outcome: 'timeout' } });
    } finally {
      delete process.env['FAKE_NAX_GENERATE_SLEEP_MS'];
    }
  });
  test('prepare fails cleanly when the default branch is missing on origin', async () => {
    const w = await world('CONFIG_EDIT');
    const row: JobRow = { ...w.row, assign: { ...w.row.assign, repo: { ...w.row.assign.repo, defaultBranch: 'trunk' } } };
    expect(await w.ex.prepareConfigJob(row)).toEqual({ ok: false, reason: 'checkout: default branch not found' });
  });
  test('matchesProcess (D486): the clone path or the job branch in argv', async () => {
    // The injected lookup reports the clone path in the config job's argv for its pid; no `ps` is spawned.
    const pids: number[] = [];
    const w = await world('CONFIG_EDIT', SEED, (repoDir) => ({
      start: async () => null,
      command: async (pid) => { pids.push(pid); return `sh -c sleep 30 ${repoDir}`; },
    }));
    await w.ex.prepareConfigJob(w.row);
    const pid = 4242;
    expect(await w.ex.matchesProcess({ ...w.row, pid, pgid: pid })).toBe(true);
    expect(await w.ex.matchesProcess({ ...w.row, jobId: 'other', jobDir: w.row.jobDir, pid, pgid: pid, assign: { ...w.row.assign, repo: { ...w.row.assign.repo, name: 'other' } } })).toBe(false);
    expect(await w.ex.matchesProcess({ ...w.row, pid: null })).toBe(false);
    expect(pids).toEqual([pid, pid]);
  });
});
