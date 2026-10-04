import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { isProcessAlive } from '../../src/executor/nax-process';
import { findRunLog } from '../../src/watcher/run-log';
import { waitFor } from '../helpers/wait';
import { createWorld, type TestRunner, type World } from './harness';

setDefaultTimeout(180_000);
const enabled = process.env['KODA_DB_TESTS'] === '1';
const sha = (bytes: Buffer): string => createHash('sha256').update(bytes).digest('hex');

describe.skipIf(!enabled)('S2a 1b: the runner streams complete logs to the real API', () => {
  let world: World;
  beforeAll(async () => { world = await createWorld(); }, 180_000);
  afterAll(async () => { await world?.close(); });

  /** Plan D329: stored file on the API's disk vs the file nax wrote, for each stream; rows complete from the stream. */
  async function expectIdentical(runner: TestRunner, jobId: string, feature: string): Promise<void> {
    const jobDir = runner.jobDir(jobId);
    const runPath = await findRunLog(join(jobDir, 'nax-out'), feature);
    expect(runPath).not.toBeNull();
    const local: Record<string, string> = { run: runPath as string, stdout: join(jobDir, 'nax.stdout'), stderr: join(jobDir, 'nax.stderr') };
    for (const [stream, path] of Object.entries(local)) {
      const stored = await readFile(join(world.base, 'artifacts', 'logs', jobId, '1', `${stream}.log`));
      expect({ stream, sha: sha(stored) }).toEqual({ stream, sha: sha(await readFile(path)) });
      const row = await world.prisma.fleetJobLog.findUnique({ where: { jobId_leaseEpoch_stream: { jobId, leaseEpoch: 1, stream } } });
      expect(row).toMatchObject({ complete: true, truncated: false, source: 'stream' });
      expect(Number(row?.sizeBytes)).toBe(stored.length);
    }
    expect((await world.events(jobId)).some((e) => e.type === 'log')).toBe(false);
  }

  async function startHeld(runner: TestRunner, feature: string, gate: string, env: Record<string, string> = {}) {
    const id = await world.withFake({ FAKE_NAX_GATE: gate, ...env }, async () => {
      const jobId = await world.dispatch({ feature });
      await world.waitForJob(jobId, (j) => j.state === 'RUNNING' && j.naxRunId !== null && j.currentStoryId === null && Number(j.costSpentUsd) > 0);
      return jobId;
    });
    return { id, pid: runner.daemon?.journal.getJob(id, 1)?.pid as number };
  }

  test('a RUN with a 3 MiB log and a 1.5 MiB line: every stream stored byte-identical and complete (success criteria 1, 2; R12)', async () => {
    const runner = await world.addRunner('logs-1');
    await runner.start();
    const id = await world.withFake({ FAKE_NAX_LOG_BYTES: '3000000', FAKE_NAX_LONG_LINE_BYTES: '1500000' }, async () => {
      const jobId = await world.dispatch({ feature: 'la' });
      await world.waitForJob(jobId, (j) => j.state === 'RUNNING');
      return jobId;
    });
    await world.waitForJob(id, (j) => j.state === 'COMPLETED', 90_000);
    await expectIdentical(runner, id, 'la');
    await runner.stop();
  });

  test('daemon crash while nax runs: the new daemon resumes at the server size and nothing is lost (Review focus 5, watch path)', async () => {
    const runner = await world.addRunner('logs-2');
    await runner.start();
    const gate = join(world.base, 'gate-lb');
    const { id, pid } = await startHeld(runner, 'lb', gate, { FAKE_NAX_LOG_BYTES: '20000000' });
    const storedRun = async () => Number((await world.prisma.fleetJobLog.findUnique({ where: { jobId_leaseEpoch_stream: { jobId: id, leaseEpoch: 1, stream: 'run' } } }))?.sizeBytes ?? 0);
    await waitFor(async () => (await storedRun()) > 0, { timeoutMs: 30_000, message: 'no run log bytes reached the API before the crash' });
    runner.net.down = true;                                         // freeze the upload mid-stream (20 MB at 4 MiB/s takes ~5 s)
    const runPath = await findRunLog(join(runner.jobDir(id), 'nax-out'), 'lb');
    expect(await storedRun()).toBeLessThan((await readFile(runPath as string)).length);   // a real resume, not a no-op
    runner.crash();
    expect(isProcessAlive(pid)).toBe(true);
    runner.net.down = false;
    await runner.start();
    await writeFile(gate, '');
    await world.waitForJob(id, (j) => j.state === 'COMPLETED', 90_000);
    await expectIdentical(runner, id, 'lb');
    await runner.stop();
  });

  test('nax finishes while the daemon is down: the finish path drains every stream before UPLOADING (R5, finish path)', async () => {
    const runner = await world.addRunner('logs-3');
    await runner.start();
    const gate = join(world.base, 'gate-lc');
    const { id, pid } = await startHeld(runner, 'lc', gate);
    runner.crash();
    await writeFile(gate, '');
    await waitFor(() => !isProcessAlive(pid), { message: 'the held nax did not finish' });
    await runner.start();
    await world.waitForJob(id, (j) => ['COMPLETED', 'ESCALATED'].includes(j.state), 90_000);
    await expectIdentical(runner, id, 'lc');
    await runner.stop();
  });
});
