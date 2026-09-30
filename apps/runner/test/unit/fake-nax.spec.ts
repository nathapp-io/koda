import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdir, readFile, readdir, readlink, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { git as sh, isolateGit, makeOrigin } from '../helpers/git-fixture';
import { makeTempDirs } from '../helpers/tmp';

const tmp = makeTempDirs();
const FAKE = join(import.meta.dir, '..', 'fixtures', 'fake-nax.ts');
beforeAll(() => isolateGit());
afterAll(() => tmp.cleanup());

interface Ctx { base: string; naxHome: string; outDir: string; work: string; originDir: string }

async function setup(branch: string | null = 'feat/x'): Promise<Ctx> {
  const base = await tmp.make('fake');
  const origin = await makeOrigin(base, 'origin', { files: { 'README.md': 'x', 'docs/spec.md': '# spec from repo\n' } });
  const work = join(base, 'work');
  await sh(base, 'clone', '-q', origin.url, work);
  await sh(work, 'config', 'user.name', 'bot');
  await sh(work, 'config', 'user.email', 'bot@x');
  if (branch) await sh(work, 'checkout', '-q', '-b', branch);
  else await sh(work, 'checkout', '-q', '--detach');
  const naxHome = join(base, 'naxhome');
  const outDir = join(base, 'out');
  await mkdir(join(naxHome, 'profiles'), { recursive: true });
  await writeFile(join(naxHome, 'profiles', 'koda-job-j1.json'), JSON.stringify({ outputDir: outDir, name: 'acme-app-12345678' }));
  return { base, naxHome, outDir, work, originDir: origin.dir };
}

function spawnFake(ctx: Ctx, args: string[], env: Record<string, string> = {}) {
  return Bun.spawn(['bun', FAKE, ...args], {
    cwd: ctx.work, stdout: 'pipe', stderr: 'pipe',
    env: { ...process.env, NAX_GLOBAL_CONFIG_DIR: ctx.naxHome, FAKE_NAX_STEP_MS: '10', ...env },
  });
}
const RUN = ['run', '--headless', '--json', '-f', 'feat', '--profile', 'fast,koda-job-j1', '--max-cost', '5'];
const PLAN = ['plan', '--from', 'docs/spec.md', '-f', 'feat', '--profile', 'koda-job-j1'];
const json = async (path: string) => JSON.parse(await readFile(path, 'utf8'));
const exists = (path: string) => stat(path).then(() => true, () => false);

describe('fake nax: run scenarios', () => {
  test('completed writes real-shaped state, three distinct run ids, latest.jsonl only at exit, commits and pushes the branch', async () => {
    const ctx = await setup();
    const proc = spawnFake(ctx, RUN);
    expect(await proc.exited).toBe(0);
    const status = await json(join(ctx.outDir, 'status.json'));
    expect(status).toMatchObject({
      version: 1, run: { status: 'completed', feature: 'feat' }, progress: { total: 3, passed: 3, pending: 0 }, current: null,
      postRun: { finish: { status: 'passed', result: 'opened', url: 'https://example.test/koda/pull/1' } },
    });
    expect(status.run.id).toMatch(/^run-/);
    expect(status.cost.spent).toBeGreaterThan(0);
    const runs = await readdir(join(ctx.outDir, 'features', 'feat', 'runs'));
    const log = runs.find((n) => n !== 'latest.jsonl');
    expect(log).toMatch(/^log-.*\.jsonl$/);
    expect(await readlink(join(ctx.outDir, 'features', 'feat', 'runs', 'latest.jsonl'))).toBe(log as string);
    expect((await readdir(join(ctx.outDir, 'cost')))[0]).toMatch(/^cost-.*\.jsonl$/);
    expect(await exists(join(ctx.outDir, 'prompt-audit', 'feat', 'p.json'))).toBe(true);
    expect(await exists(join(ctx.outDir, 'metrics.json'))).toBe(true);
    const ledger = await json(join(ctx.outDir, 'finish-audit', 'feat', 'last.json'));
    expect(ledger).toMatchObject({ branch: 'feat/x', status: 'opened' });
    expect(ledger.headSha).toBe(await sh(ctx.work, 'rev-parse', 'HEAD'));
    expect(await sh(ctx.originDir, 'rev-parse', 'feat/x')).toBe(ledger.headSha);
    expect(await sh(ctx.work, 'log', '-1', '--format=%s')).toContain('feat');
  });
  test('a detached HEAD skips the finish push, as nax does', async () => {
    const ctx = await setup(null);
    expect(await spawnFake(ctx, RUN).exited).toBe(0);
    expect((await json(join(ctx.outDir, 'status.json'))).postRun.finish).toMatchObject({ status: 'skipped', reason: 'branch' });
  });
  test('escalated and failed end with nax-shaped verdict inputs', async () => {
    const esc = await setup();
    expect(await spawnFake(esc, RUN, { FAKE_NAX_SCENARIO: 'escalated' }).exited).toBe(0);
    expect((await json(join(esc.outDir, 'status.json'))).postRun.finish).toMatchObject({ result: 'escalated', escalationReason: 'fake escalation' });
    const ledger = await json(join(esc.outDir, 'finish-audit', 'feat', 'last.json'));
    expect(ledger).toMatchObject({ branch: 'feat/x', status: 'escalated' });
    expect(ledger.headSha).toBe(await sh(esc.work, 'rev-parse', 'HEAD'));
    const failed = await setup();
    // Real `nax run` exits 1 when the run failed (nax bin/nax.ts:383, `process.exit(result.success ? 0 : 1)`); the runner never reads it (D70).
    expect(await spawnFake(failed, RUN, { FAKE_NAX_SCENARIO: 'failed' }).exited).toBe(1);
    expect((await json(join(failed.outDir, 'status.json'))).run.status).toBe('failed');
  });
  test('crashed dies by SIGKILL leaving status running', async () => {
    const ctx = await setup();
    const proc = spawnFake(ctx, RUN, { FAKE_NAX_SCENARIO: 'crashed' });
    await proc.exited;
    expect(proc.signalCode).toBe('SIGKILL');
    expect((await json(join(ctx.outDir, 'status.json'))).run.status).toBe('running');
  });
  test('hang keeps heartbeating until SIGTERM, then writes status crashed as nax does; the gate holds a finished run back', async () => {
    const ctx = await setup();
    const proc = spawnFake(ctx, RUN, { FAKE_NAX_SCENARIO: 'hang' });
    for (let i = 0; i < 100 && !(await exists(join(ctx.outDir, 'status.json'))); i += 1) await Bun.sleep(20);
    const first = await json(join(ctx.outDir, 'status.json'));
    expect(first.run.status).toBe('running');
    process.kill(proc.pid, 'SIGTERM');
    expect(await proc.exited).toBe(0);
    expect((await json(join(ctx.outDir, 'status.json'))).run).toMatchObject({ status: 'crashed', crashSignal: 'SIGTERM' });

    const gated = await setup();
    const gate = join(gated.base, 'gate');
    const p2 = spawnFake(gated, RUN, { FAKE_NAX_GATE: gate });
    // Poll for the state that proves the gate is what holds the run (all steps done, still running); no fixed sleep.
    let held = false;
    for (let i = 0; i < 500 && !held; i += 1) {
      held = await json(join(gated.outDir, 'status.json')).then((s) => s.progress.passed === 3, () => false);
      if (!held) await Bun.sleep(20);
    }
    expect(held).toBe(true);
    expect(p2.exitCode).toBeNull();
    expect((await json(join(gated.outDir, 'status.json'))).run.status).toBe('running');
    await writeFile(gate, '');
    expect(await p2.exited).toBe(0);
    expect((await json(join(gated.outDir, 'status.json'))).run.status).toBe('completed');
  });
  test('fails loudly without a job profile (the runner must always pass one)', async () => {
    const ctx = await setup();
    const proc = spawnFake(ctx, ['run', '-f', 'feat', '--profile', 'fast']);
    expect(await proc.exited).toBe(2);
  });
});

describe('fake nax: plan scenarios', () => {
  test('plan-valid writes the PRD and companions untracked, plus logs, and no status.json', async () => {
    const ctx = await setup(null);
    expect(await spawnFake(ctx, PLAN).exited).toBe(0);
    const dir = join(ctx.work, '.nax', 'features', 'feat');
    const prd = await json(join(dir, 'prd.json'));
    expect(prd).toMatchObject({ feature: 'feat', branchName: 'feat/feat' });
    expect(prd.userStories.length).toBeGreaterThan(0);
    expect(await readFile(join(dir, 'spec.md'), 'utf8')).toContain('spec from repo');
    for (const f of ['prd-fidelity-report.md', 'acceptance-meta.json', 'plan/plan-1.jsonl', 'sessions/s1.json']) expect(await exists(join(dir, f))).toBe(true);
    expect(await exists(join(dir, 'prd.rejected.json'))).toBe(false);
    expect(await exists(join(ctx.outDir, 'status.json'))).toBe(false);
    expect(await sh(ctx.work, 'status', '--porcelain')).toContain('.nax/');
  });
  test('plan-invalid writes an empty PRD and a rejected copy; the branch is configurable', async () => {
    const ctx = await setup(null);
    await spawnFake(ctx, PLAN, { FAKE_NAX_SCENARIO: 'plan-invalid' }).exited;
    const dir = join(ctx.work, '.nax', 'features', 'feat');
    expect((await json(join(dir, 'prd.json'))).userStories).toEqual([]);
    expect(await exists(join(dir, 'prd.rejected.json'))).toBe(true);
    const other = await setup(null);
    await spawnFake(other, PLAN, { FAKE_NAX_PLAN_BRANCH: 'plan/custom' }).exited;
    expect((await json(join(other.work, '.nax', 'features', 'feat', 'prd.json'))).branchName).toBe('plan/custom');
  });
});
