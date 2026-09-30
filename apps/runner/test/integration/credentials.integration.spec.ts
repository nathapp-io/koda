import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from 'bun:test';
import { existsSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { delimiter, join } from 'node:path';
import { defaultSocketDir, socketPathFor } from '../../src/credentials/socket-dir';
import { git as sh } from '../helpers/git-fixture';
import { waitFor } from '../helpers/wait';
import { createWorld, type TestRunner, type World } from './harness';
import { HARNESS_TOKEN } from './harness/forge';

setDefaultTimeout(120_000);
const enabled = process.env['KODA_DB_TESTS'] === '1';

describe.skipIf(!enabled)('runner 3b-1 against the real API: git credentials', () => {
  let world: World;
  let runner: TestRunner;
  beforeAll(async () => {
    world = await createWorld();
    runner = await world.addRunner('creds');
    await runner.start();
  }, 180_000);
  afterAll(async () => { await world?.close(); });

  const receivePacks = () => world.gitRequests.filter((r) => r.authorized && r.path.includes('git-receive-pack')).length;

  test('RUN: clone, fetch, the finish push and gh pr create go through the broker; the token is never in nax\'s env, the journal or the logs', async () => {
    const dump = join(world.base, 'nax-env-fa.json');
    const id = await world.withFake({ FAKE_NAX_GH: '1', FAKE_NAX_ENV_DUMP: dump }, async () => {
      const jobId = await world.dispatch({ feature: 'fa' });
      await world.waitForJob(jobId, (j) => j.state === 'COMPLETED', 60_000);
      return jobId;
    });
    const job = await world.job(id);
    expect(job).toMatchObject({ resultPrUrl: 'https://example.test/koda/pull/7', resultBranch: 'feat/fa', finishResult: 'opened' });
    expect(job.resultSha).toBe(await sh(world.origin.dir, 'rev-parse', 'feat/fa'));
    expect(world.gitRequests.some((r) => r.authorized && r.path.includes('git-upload-pack'))).toBe(true);
    expect(receivePacks()).toBeGreaterThan(0);

    const env = JSON.parse(await readFile(dump, 'utf8')) as Record<string, string>;
    expect(JSON.stringify(env)).not.toContain(HARNESS_TOKEN);
    expect(env['PATH'].split(delimiter)[0]).toBe(join(runner.jobDir(id), 'bin'));
    const gh = (await readFile(world.fakeGh.logPath, 'utf8')).trim().split('\n').map((line) => JSON.parse(line)).filter((e) => e.argv[0] === 'pr');
    expect(gh.at(-1)).toMatchObject({ ghToken: HARNESS_TOKEN, argv: expect.arrayContaining(['pr', 'create', '--head', 'feat/fa']) });

    expect((await runner.journalBytes()).includes(Buffer.from(HARNESS_TOKEN))).toBe(false);
    expect(JSON.stringify(runner.log.lines)).not.toContain(HARNESS_TOKEN);
  });

  test('PLAN: the plan commit reaches origin through the helper', async () => {
    const id = await world.dispatch({ feature: 'fb', command: 'PLAN', planFrom: 'docs/spec.md' });
    const job = await world.waitForJob(id, (j) => j.state === 'COMPLETED', 60_000);
    expect(job.resultBranch).toBe('feat/fb');
    expect(await sh(world.origin.dir, 'log', '-1', '--format=%s', 'feat/fb')).toBe(`chore(plan): fb PRD via koda job ${id}`);
  });

  test('D82: a token the forge refuses fails the job before any clone, with the server\'s reason', async () => {
    const route = 'POST /app/installations/77/access_tokens';
    const saved = world.forge.routes.get(route);
    world.forge.routes.set(route, () => ({ status: 403, body: { message: 'Resource not accessible by integration' } }));
    try {
      const id = await world.dispatch({ feature: 'fc' });
      const job = await world.waitForJob(id, (j) => j.state === 'FAILED', 60_000);
      expect(job.stateReason).toBe('git token: app_permissions_insufficient');
    } finally {
      if (saved) world.forge.routes.set(route, saved);
    }
  });

  test('Review focus 3: after a daemon crash the readopted run still pushes: the new daemon serves the job socket again', async () => {
    const gate = join(world.base, 'gate-fd');
    const id = await world.withFake({ FAKE_NAX_GATE: gate }, async () => {
      const jobId = await world.dispatch({ feature: 'fd' });
      await world.waitForJob(jobId, (j) => j.state === 'RUNNING' && j.naxRunId !== null && j.currentStoryId === null && Number(j.costSpentUsd) > 0);
      return jobId;
    });
    runner.crash();
    await runner.start();
    await waitFor(async () => (await world.prisma.fleetCommand.findMany({ where: { jobId: id, type: 'READOPT' } })).some((c) => c.ackResult === 'ok'), { timeoutMs: 30_000, message: 'READOPT was not acked ok' });
    const { runnerId } = await runner.identity();
    const sock = socketPathFor(defaultSocketDir(process.getuid?.() ?? 0), runnerId, id, 1);
    await waitFor(() => existsSync(sock), { timeoutMs: 30_000, message: 'the restarted daemon did not re-open the job socket' });
    const before = receivePacks();
    await writeFile(gate, '');
    const job = await world.waitForJob(id, (j) => j.state === 'COMPLETED' || j.state === 'ESCALATED', 60_000);
    expect(job.state).toBe('COMPLETED');                                   // ESCALATED here means the push had no credentials
    expect(job.resultBranch).toBe('feat/fd');
    expect(receivePacks()).toBeGreaterThan(before);
  });
});
