import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from 'bun:test';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { isProcessAlive } from '../../src/executor/nax-process';
import { waitFor } from '../helpers/wait';
import { createWorld, type TestRunner, type World } from './harness';

setDefaultTimeout(120_000);
const enabled = process.env['KODA_DB_TESTS'] === '1';

describe.skipIf(!enabled)('runner 3a against the real API: recovery', () => {
  let world: World;
  beforeAll(async () => { world = await createWorld(); }, 180_000);
  afterAll(async () => { await world?.close(); });

  const readopts = (jobId: string) => world.prisma.fleetCommand.findMany({ where: { jobId, type: 'READOPT' } });

  async function startHeld(runner: TestRunner, feature: string, gate: string) {
    const id = await world.withFake({ FAKE_NAX_GATE: gate }, async () => {
      const jobId = await world.dispatch({ feature });
      await world.waitForJob(jobId, (j) => j.state === 'RUNNING' && j.naxRunId !== null && j.currentStoryId === null && Number(j.costSpentUsd) > 0);
      return jobId;
    });
    const row = runner.daemon?.journal.getJob(id, 1);
    return { id, pid: row?.pid as number };
  }

  test('daemon crash while nax keeps running: READOPT is acked ok, the same process finishes the job, nothing is lost (Review focus 1)', async () => {
    const runner = await world.addRunner('recover-1');
    await runner.start();
    const gate = join(world.base, 'gate-fd');
    const { id, pid } = await startHeld(runner, 'fd', gate);
    const firstBoot = runner.daemon?.bootId;
    runner.crash();
    expect(isProcessAlive(pid)).toBe(true);                       // crash() drains nothing and touches no child (D40, D67)
    const second = await runner.start();
    expect(second.bootId).not.toBe(firstBoot);
    await waitFor(async () => (await readopts(id)).some((c) => c.ackResult === 'ok'), { timeoutMs: 30_000, message: 'READOPT was not acked ok' });
    expect((await world.job(id)).state).toBe('RUNNING');
    expect(second.journal.getJob(id, 1)?.pid).toBe(pid);
    await writeFile(gate, '');
    const job = await world.waitForJob(id, (j) => j.state === 'COMPLETED');
    expect(job.resultBranch).toBe('feat/fd');
    expect((await world.events(id)).some((e) => e.type === 'state' && (e.payload as { to: string }).to === 'CRASHED')).toBe(false);
    expect((await world.downloadBundle(id)).status).toBe(200);
    await runner.stop();
  });

  test('a run that finishes while the daemon is down is verdicted, bundled and reported after READOPT, not lost', async () => {
    const runner = await world.addRunner('recover-2');
    await runner.start();
    const gate = join(world.base, 'gate-fe');
    const { id, pid } = await startHeld(runner, 'fe', gate);
    runner.crash();
    await writeFile(gate, '');
    await waitFor(() => !isProcessAlive(pid), { message: 'the held nax did not finish' });
    const status = JSON.parse(await readFile(join(runner.jobDir(id), 'nax-out', 'status.json'), 'utf8'));
    expect(status.run.status).toBe('completed');
    expect((await world.job(id)).state).toBe('RUNNING');          // the server has heard nothing since the daemon went down
    await runner.start();
    const job = await world.waitForJob(id, (j) => j.state === 'COMPLETED', 60_000);
    expect(job).toMatchObject({ resultBranch: 'feat/fe', resultPrUrl: 'https://example.test/koda/pull/1' });
    expect((await readopts(id)).some((c) => c.ackResult === 'ok')).toBe(true);
    expect((await world.downloadBundle(id)).status).toBe(200);
    await runner.stop();
  });

  test('a network cut mid-run (responses lost): the first resent seq is ackedSeq+1, nothing is stored twice, there is no gap (Review focus 3, D71)', async () => {
    const runner = await world.addRunner('recover-3');
    await runner.start();
    const gate = join(world.base, 'gate-ff');
    const id = await world.withFake({ FAKE_NAX_GATE: gate, FAKE_NAX_STEPS: '14', FAKE_NAX_STEP_MS: '150' }, async () => {
      const jobId = await world.dispatch({ feature: 'ff' });
      await world.waitForJob(jobId, (j) => j.state === 'RUNNING' && j.naxRunId !== null);
      return jobId;
    });
    const journal = runner.daemon?.journal;
    // The cut: requests still reach the server, the runner never hears the answers. Every response is dropped, so its ack cursor freezes.
    runner.net.dropResponse = true;
    await waitFor(() => runner.net.syncs.some((s) => s.outcome === 'dropped' && s.jobs.some((j) => j.jobId === id && j.seqs.length > 0)), { message: 'no sync with events was performed during the cut' });
    await waitFor(() => (journal?.pendingEvents(id, 1, 1_000).length ?? 0) > 3, { message: 'events did not stay unacknowledged during the cut' });
    const ackedAtCut = (journal?.pendingEvents(id, 1, 1)[0]?.seq ?? 0) - 1;
    const storedDuringCut = await world.prisma.fleetJobEvent.findMany({ where: { jobId: id, runnerSeq: { not: null } }, orderBy: { runnerSeq: 'asc' }, select: { id: true, runnerSeq: true } });
    expect(storedDuringCut.length).toBeGreaterThan(ackedAtCut);          // the server kept events the runner could not confirm
    const cutSyncs = runner.net.syncs.length;
    runner.net.dropResponse = false;                                     // the network is back ...
    await writeFile(gate, '');                                           // ... and only now may the held nax finish: no wall-clock race
    const job = await world.waitForJob(id, (j) => j.state === 'COMPLETED', 60_000);
    expect(job.stateReason).toBeNull();
    await waitFor(() => (journal?.jobsWithPending().length ?? 1) === 0, { message: 'the journal was not fully acknowledged' });

    const firstAfter = runner.net.syncs.slice(cutSyncs).find((s) => s.outcome === 'delivered' && s.jobs.some((j) => j.jobId === id && j.seqs.length > 0));
    const resent = firstAfter?.jobs.find((j) => j.jobId === id)?.seqs ?? [];
    expect(resent[0]).toBe(ackedAtCut + 1);                              // resent from the ack cursor, not from 1 and not past it
    expect(resent).toEqual(resent.map((_, i) => resent[0] + i));         // contiguous: nothing skipped inside the batch

    const rows = await world.prisma.fleetJobEvent.findMany({ where: { jobId: id, runnerSeq: { not: null } }, orderBy: { runnerSeq: 'asc' }, select: { id: true, runnerSeq: true } });
    const seqs = rows.map((r) => r.runnerSeq as number);
    expect(seqs).toEqual(Array.from({ length: seqs.length }, (_, i) => i + 1));   // no gap and no duplicate
    expect(rows.slice(0, storedDuringCut.length)).toEqual(storedDuringCut);       // re-sent seqs created no extra row and replaced none
    expect(seqs.length).toBeGreaterThan(storedDuringCut.length);                   // what happened after the cut arrived as well
    await runner.stop();
  });

  test('a stale epoch: the fenced runner is told ABANDON, kills the group, drops that epoch and pushes nothing (Review focus 4)', async () => {
    const runner = await world.addRunner('recover-4');
    await runner.start();
    const id = await world.withFake({ FAKE_NAX_SCENARIO: 'hang' }, async () => {
      const jobId = await world.dispatch({ feature: 'fg' });
      await world.waitForJob(jobId, (j) => j.state === 'RUNNING' && j.naxRunId !== null);
      return jobId;
    });
    const journal = runner.daemon?.journal;
    const pid = journal?.getJob(id, 1)?.pid as number;
    expect(isProcessAlive(pid)).toBe(true);
    // What the silence sweep does to a job whose runner it gave up on (the 2b plan's sweep): CRASHED and a bumped lease epoch.
    await world.prisma.fleetJob.update({ where: { id }, data: { state: 'CRASHED', leaseEpoch: { increment: 1 } } });
    await waitFor(async () => (await world.prisma.fleetCommand.count({ where: { jobId: id, type: 'ABANDON', ackResult: 'ok' } })) === 1, { timeoutMs: 30_000, message: 'ABANDON was not acked ok' });
    await waitFor(() => !isProcessAlive(pid), { message: 'the fenced process was not killed' });
    expect(journal?.getJob(id, 1)).toBeNull();
    expect(journal?.pendingEvents(id, 1, 100)).toEqual([]);
    const after = await world.job(id);
    expect(after.state).toBe('CRASHED');
    expect(await world.prisma.fleetJobArtifact.count({ where: { jobId: id } })).toBe(0);
    await runner.stop();
  });
});
