import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from 'bun:test';
import { createWorld, assertPartialIndex, type World } from './harness';

setDefaultTimeout(120_000);
const enabled = process.env['KODA_DB_TESTS'] === '1';

describe.skipIf(!enabled)('integration harness', () => {
  let world: World;
  beforeAll(async () => { world = await createWorld(); }, 180_000);
  afterAll(async () => { await world?.close(); });

  test('the API answers, the partial unique index shipped by the migrations exists, and only *_test databases are touched', async () => {
    const health = await fetch(`${world.api.url}/api/health`);
    expect(health.status).toBe(200);
    await assertPartialIndex(world.prisma);
    const [db] = await world.prisma.$queryRaw<Array<{ current_database: string }>>`SELECT current_database()`;
    expect(db.current_database).toBe('koda_runner_test');
  });

  test('a runner enrolls over HTTP, syncs, and shows up online with its capabilities', async () => {
    const runner = await world.addRunner('probe-1');
    await runner.start();
    try {
      const row = await world.prisma.runner.findUniqueOrThrow({ where: { name: 'probe-1' } });
      expect(row).toMatchObject({ enabled: true, capacity: 1, os: process.platform });
      const { waitFor } = await import('../helpers/wait');
      await waitFor(async () => (await world.prisma.runner.findUniqueOrThrow({ where: { name: 'probe-1' } })).bootId === runner.daemon?.bootId);
      expect((await world.prisma.runner.findUniqueOrThrow({ where: { name: 'probe-1' } })).capabilities).toMatchObject({ tools: { git: true, gh: true }, executors: ['host'] });
    } finally {
      await runner.stop();
    }
  });

  test('the net control records each sync\'s event seqs and can drop a response after the request was performed (D71)', async () => {
    const runner = await world.addRunner('probe-net');
    await runner.start();
    try {
      const { waitFor } = await import('../helpers/wait');
      await waitFor(() => runner.net.syncs.some((s) => s.outcome === 'delivered'));
      runner.net.dropResponse = true;
      await waitFor(() => runner.net.syncs.some((s) => s.outcome === 'dropped'));
      runner.net.down = true;
      runner.net.dropResponse = false;
      await waitFor(() => runner.net.syncs.some((s) => s.outcome === 'refused'));
      runner.net.down = false;
      const count = runner.net.syncs.length;
      await waitFor(() => runner.net.syncs.length > count && runner.net.syncs.at(-1)?.outcome === 'delivered');
    } finally {
      await runner.stop();
    }
  });

  test('a world that fails half way unwinds what it started (D73)', async () => {
    const { readdir } = await import('node:fs/promises');
    const { tmpdir } = await import('node:os');
    const worlds = async () => (await readdir(tmpdir())).filter((name) => name.startsWith('koda-runner-it-')).length;
    const before = await worlds();
    const saved = process.env['KODA_RUNNER_TEST_DATABASE_URL'];
    process.env['KODA_RUNNER_TEST_DATABASE_URL'] = 'postgresql://koda:koda@db.example.com:5433/koda_runner_test';   // refused by assertSafeTestDatabaseUrl
    try {
      await expect(createWorld()).rejects.toThrow();
    } finally {
      if (saved === undefined) delete process.env['KODA_RUNNER_TEST_DATABASE_URL'];
      else process.env['KODA_RUNNER_TEST_DATABASE_URL'] = saved;
    }
    expect(await worlds()).toBe(before);                               // the temp directory was removed
  });

  test('the fake forge origin serves the seeded repository through the insteadOf mapping', async () => {
    const proc = Bun.spawn(['git', 'ls-remote', world.forgeCloneUrl], { stdout: 'pipe', stderr: 'pipe', env: { ...process.env } });
    expect(await new Response(proc.stdout).text()).toContain('refs/heads/main');
    expect(await proc.exited).toBe(0);
  });

  test('dispatch reaches a runner, the fake nax runs, and the job completes (a smoke test of every seam)', async () => {
    const runner = await world.addRunner('probe-2');
    await runner.start();
    try {
      const id = await world.dispatch({ feature: 'fa' });
      const job = await world.waitForJob(id, (j) => j.state === 'COMPLETED', 60_000);
      expect(job.resultPrUrl).toBe('https://example.test/koda/pull/1');
    } finally {
      await runner.stop();
    }
  });
});
