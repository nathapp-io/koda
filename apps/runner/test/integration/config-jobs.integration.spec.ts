import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from 'bun:test';
import { git as sh, pushCommit } from '../helpers/git-fixture';
import { createWorld, type EventView, type TestRunner, type World } from './harness';

setDefaultTimeout(120_000);
const enabled = process.env['KODA_DB_TESTS'] === '1';
const runnerStates = (events: EventView[]) => events.filter((e) => e.type === 'state').map((e) => (e.payload as { to: string }).to);
const terminal = (state: string) => ['COMPLETED', 'FAILED', 'CANCELLED', 'CRASHED'].includes(state);
const onOrigin = (world: World, branch: string) => sh(world.origin.dir, 'rev-parse', '--verify', branch).then(() => true, () => false);

describe.skipIf(!enabled)('S3 config jobs against the real API', () => {
  let world: World;
  let runner: TestRunner;
  beforeAll(async () => {
    world = await createWorld();
    runner = await world.addRunner('config');
    await runner.start();
  }, 180_000);
  afterAll(async () => { await world?.close(); });

  test('edit: PR branch with the edit and the regenerated agent files; result stored; no bundle', async () => {
    const baseSha = await sh(world.origin.dir, 'rev-parse', 'main');
    const blob = await sh(world.origin.dir, 'rev-parse', 'main:.nax/rules/a.md');
    const id = await world.submitConfigEdit({
      baseSha, prTitle: 'Tighten rule a', prBody: 'Because',
      edits: [{ path: '.nax/rules/a.md', op: 'put', content: '# rule a, tightened\n', baseSha: blob }, { path: '.nax/rules/b.md', op: 'put', content: '# rule b\n', baseSha: null }],
    });
    const job = await world.waitForJob(id, (j) => terminal(j.state));
    expect(job).toMatchObject({ state: 'COMPLETED', resultBranch: `nax-config/${id}`, resultPrUrl: 'https://example.test/koda/pull/7' });
    expect(job.resultSha).toBe(await sh(world.origin.dir, 'rev-parse', `nax-config/${id}`));
    expect(await sh(world.origin.dir, 'show', `nax-config/${id}:.nax/rules/b.md`)).toBe('# rule b');
    expect(await sh(world.origin.dir, 'show', `nax-config/${id}:CLAUDE.md`)).toContain('# app context');
    expect(await world.configEdit(id)).toEqual({ mode: 'edit', result: { outcome: 'ok', files: ['.nax/rules/a.md', '.nax/rules/b.md', 'AGENTS.md', 'CLAUDE.md'] } });
    const events = await world.events(id);
    expect(runnerStates(events)).toEqual(expect.arrayContaining(['ASSIGNED', 'RUNNING', 'UPLOADING', 'COMPLETED']));
    expect((await world.downloadBundle(id)).status).toBe(404);
  });

  test('conflict: an edited file changed upstream fails the job and pushes nothing', async () => {
    const baseSha = await sh(world.origin.dir, 'rev-parse', 'main');
    const blob = await sh(world.origin.dir, 'rev-parse', 'main:.nax/rules/a.md');
    await pushCommit(world.base, world.origin.url, 'main', '.nax/rules/a.md', '# rule a, changed by a teammate\n');
    const id = await world.submitConfigEdit({ baseSha, prTitle: 'Mine', edits: [{ path: '.nax/rules/a.md', op: 'put', content: '# mine\n', baseSha: blob }] });
    const job = await world.waitForJob(id, (j) => terminal(j.state));
    expect(job).toMatchObject({ state: 'FAILED', stateReason: 'conflict' });
    expect(await world.configEdit(id)).toMatchObject({ result: { outcome: 'conflict', files: ['.nax/rules/a.md'] } });
    expect(await onOrigin(world, `nax-config/${id}`)).toBe(false);
  });

  test('invalid: a rule nax lint rejects opens no PR', async () => {
    const id = await world.submitConfigEdit({
      baseSha: await sh(world.origin.dir, 'rev-parse', 'main'), prTitle: 'Bad rule',
      edits: [{ path: '.nax/rules/bad.md', op: 'put', content: 'FAKE_LINT_FAIL\n', baseSha: null }],
    });
    const job = await world.waitForJob(id, (j) => terminal(j.state));
    expect(job).toMatchObject({ state: 'FAILED', stateReason: 'invalid', resultPrUrl: null });
    const stored = await world.configEdit(id);
    expect((stored.result as { output: string }).output).toContain('banned marker FAKE_LINT_FAIL');
    expect(await onOrigin(world, `nax-config/${id}`)).toBe(false);
  });

  test('drift: lists the stale generated files and pushes nothing', async () => {
    const id = await world.queueConfigJob({ command: 'CONFIG_DRIFT', mode: 'drift' });
    const job = await world.waitForJob(id, (j) => terminal(j.state));
    expect(job.state).toBe('COMPLETED');
    expect(await world.configEdit(id)).toMatchObject({ result: { outcome: 'drift', files: expect.arrayContaining(['AGENTS.md', 'CLAUDE.md']) } });
    expect(await onOrigin(world, `nax-config/${id}`)).toBe(false);
  });

  test('regenerate: a failed create falls back to the PR that already exists', async () => {
    await world.withFake({ FAKE_GH_CREATE_EXIT: '1', FAKE_GH_EXISTING_PR_URL: 'https://example.test/koda/pull/42' }, async () => {
      const id = await world.queueConfigJob({ command: 'CONFIG_EDIT', mode: 'regenerate', prTitle: 'Regenerate agent files' });
      const job = await world.waitForJob(id, (j) => terminal(j.state));
      expect(job).toMatchObject({ state: 'COMPLETED', resultPrUrl: 'https://example.test/koda/pull/42', resultBranch: `nax-config/${id}` });
    });
  });

  test('cancel while nax runs ends CANCELLED long before the slow call would finish', async () => {
    await world.withFake({ FAKE_NAX_GENERATE_SLEEP_MS: '30000' }, async () => {
      const id = await world.queueConfigJob({ command: 'CONFIG_DRIFT', mode: 'drift' });
      await world.waitForJob(id, (j) => j.state === 'RUNNING');
      await Bun.sleep(1_000);
      const started = Date.now();
      await world.cancel(id);
      const job = await world.waitForJob(id, (j) => terminal(j.state), 20_000);
      expect(job.state).toBe('CANCELLED');
      expect(Date.now() - started).toBeLessThan(15_000);
    });
  });

  test('a runner restart mid-job: READOPT rejects it and the server marks it CRASHED (D485)', async () => {
    await world.withFake({ FAKE_NAX_GENERATE_SLEEP_MS: '30000' }, async () => {
      const id = await world.queueConfigJob({ command: 'CONFIG_DRIFT', mode: 'drift' });
      await world.waitForJob(id, (j) => j.state === 'RUNNING');
      await Bun.sleep(1_000);
      runner.crash();
      await runner.start();
      const job = await world.waitForJob(id, (j) => terminal(j.state), 30_000);
      expect(job).toMatchObject({ state: 'CRASHED', stateReason: 'readopt rejected: config job interrupted by a runner restart' });
    });
  });
});
