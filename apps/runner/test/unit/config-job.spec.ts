import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { readFile } from 'node:fs/promises';
import { delimiter, join } from 'node:path';
import type { AssignPayload, ConfigEditPayload } from '@nathapp/fleet-protocol';
import type { ConfigJobContext } from '../../src/executor/job-executor';
import { HostExecutor } from '../../src/executor/host-executor';
import { createGit } from '../../src/executor/git';
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

async function world(command: 'CONFIG_EDIT' | 'CONFIG_DRIFT', files: Record<string, string> = SEED) {
  const base = await tmp.make('cfg-host');
  const origin = await makeOrigin(base, 'origin', { files });
  const workspaceRoot = join(base, 'ws');
  const assign: AssignPayload = assignFor(command, { jobId: 'cjob1', repo: { provider: 'github', owner: 'acme', name: 'app', defaultBranch: 'main', cloneUrl: origin.url } });
  const journal = Journal.open(':memory:');
  const row: JobRow = journal.insertJob({ assign, leaseEpoch: 1, repoKey: 'acme/app', jobDir: jobDirFor(workspaceRoot, 'cjob1') }).row;
  const ex = new HostExecutor({
    config: { workspaceRoot, naxCommand: ['bun', FAKE], naxHome: join(base, 'naxhome') }, git: createGit(), log: createMemoryLogger(),
    nowMs: () => Date.now(), sleep: async () => undefined, credentials: NO_CREDENTIALS, approvals: NO_APPROVALS,
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
    const w = await world('CONFIG_EDIT');
    await w.ex.prepareConfigJob(w.row);
    const proc = Bun.spawn(['sh', '-c', 'sleep 30', w.repoDir], { stdout: 'ignore', stderr: 'ignore' });
    try {
      expect(await w.ex.matchesProcess({ ...w.row, pid: proc.pid, pgid: proc.pid })).toBe(true);
      expect(await w.ex.matchesProcess({ ...w.row, jobId: 'other', jobDir: w.row.jobDir, pid: proc.pid, pgid: proc.pid, assign: { ...w.row.assign, repo: { ...w.row.assign.repo, name: 'other' } } })).toBe(false);
      expect(await w.ex.matchesProcess({ ...w.row, pid: null })).toBe(false);
    } finally {
      proc.kill('SIGKILL');
    }
  });
});
