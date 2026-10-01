import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from 'bun:test';
import { git as sh } from '../helpers/git-fixture';
import { waitFor } from '../helpers/wait';
import { createWorld, type TestRunner, type World } from './harness';

setDefaultTimeout(120_000);
const enabled = process.env['KODA_DB_TESTS'] === '1';

describe.skipIf(!enabled)('S1b 1a: an unfinished RUN pushes its progress and another runner continues it', () => {
  let world: World;
  let a: TestRunner;
  let b: TestRunner;
  let aId: string;
  let bId: string;
  beforeAll(async () => {
    world = await createWorld();
    a = await world.addRunner('wip-a');
    b = await world.addRunner('wip-b');
    await a.start();
    await b.start();
    aId = (await a.identity()).runnerId;
    bId = (await b.identity()).runnerId;
  }, 180_000);
  afterAll(async () => { await world?.close(); });

  test('FAILED on runner A pushes story commits plus only prd.json; COMPLETED on runner B continues that branch', async () => {
    const first = await world.withFake({ FAKE_NAX_SCENARIO: 'failed', FAKE_NAX_DIRTY_PRD: '1' }, async () => {
      const id = await world.dispatch({ feature: 'fd', pinnedRunnerId: aId });
      return world.waitForJob(id, (j) => j.state === 'FAILED');
    });
    expect(first).toMatchObject({ stateReason: 'run status: failed', wipPush: 'pushed', resultBranch: 'feat/fd' });
    // S1b 1b: the final watcher tick read the PRD nax left behind (FAKE_NAX_DIRTY_PRD marks US-001 passed).
    expect(first.stories).toEqual([{ id: 'US-001', title: 'story', status: 'passed', attempts: 1, dependsOn: [] }]);
    expect(first.storiesTruncated).toBe(false);
    const tip = await sh(world.origin.dir, 'rev-parse', 'feat/fd');
    expect(first.resultSha).toBe(tip);
    expect(await sh(world.origin.dir, 'log', '-1', '--format=%s|%an|%ae', 'feat/fd')).toBe(`chore(nax): progress of fd via koda job ${first.id}|koda-fleet[bot]|koda-fleet[bot]@users.noreply.github.com`);
    expect(await sh(world.origin.dir, 'show', '--name-only', '--format=', 'feat/fd')).toBe('.nax/features/fd/prd.json');
    expect(await sh(world.origin.dir, 'log', '-1', '--format=%s', 'feat/fd~1')).toContain('fake story work');
    expect(await sh(world.origin.dir, 'ls-tree', '-r', '--name-only', 'feat/fd')).not.toContain('koda-fake-uncommitted.txt');

    const secondId = await world.dispatch({ feature: 'fd', pinnedRunnerId: bId });
    const second = await world.waitForJob(secondId, (j) => j.state === 'COMPLETED');
    expect(second.runnerId).toBe(bId);
    expect(second.wipPush).toBeNull();
    await sh(world.origin.dir, 'merge-base', '--is-ancestor', tip, 'feat/fd');   // throws if B did not build on A's push
    const subjects = (await sh(world.origin.dir, 'log', '--format=%s', 'main..feat/fd')).split('\n');
    expect(subjects.filter((s) => s.includes('fake story work'))).toHaveLength(2);
  });

  test('a cost-limit stop pushes too', async () => {
    const job = await world.withFake({ FAKE_NAX_SCENARIO: 'cost-limit' }, async () => {
      const id = await world.dispatch({ feature: 'fe', pinnedRunnerId: aId });
      return world.waitForJob(id, (j) => j.state === 'FAILED');
    });
    expect(job).toMatchObject({ stateReason: 'run status: cost-limit', wipPush: 'pushed', resultBranch: 'feat/fe' });
    expect(job.stories).toEqual([{ id: 'US-001', title: 'story', status: 'pending', attempts: 0, dependsOn: [] }]);
    expect(job.resultSha).toBe(await sh(world.origin.dir, 'rev-parse', 'feat/fe'));
  });

  test('a halt between nax exit and the progress push pushes nothing (D144, D153)', async () => {
    const hold = world.holdPushes();
    try {
      const id = await world.withFake({ FAKE_NAX_SCENARIO: 'failed' }, async () => {
        const jobId = await world.dispatch({ feature: 'fh', pinnedRunnerId: aId });
        await hold.reached;   // nax has exited and the progress push is on the wire
        return jobId;
      });
      const held = await world.job(id);
      expect(held.state).toBe('RUNNING');
      // What the silence sweep and FenceService.abandon write. The runner's own fence would need a sync that
      // mentions the job, which an exited nax no longer guarantees (D153).
      await world.prisma.$transaction([
        world.prisma.fleetJob.update({ where: { id }, data: { state: 'CRASHED', leaseEpoch: { increment: 1 } } }),
        world.prisma.fleetCommand.create({ data: { runnerId: aId, jobId: id, type: 'ABANDON', leaseEpoch: held.leaseEpoch, payload: { reason: 'stale_lease' } } }),
      ]);
      await waitFor(
        async () => (await world.prisma.fleetCommand.count({ where: { jobId: id, type: 'ABANDON', deliveredAt: { not: null } } })) > 0,
        { timeoutMs: 15_000, message: 'ABANDON was not delivered' },
      );
      // abandon() waits for the repo mutex the push holds, so the ack comes only after the push gives up. The failed
      // attempt's 2 s back-off is where the push sees the halt.
      hold.fail();
      await waitFor(
        async () => (await world.prisma.fleetCommand.count({ where: { jobId: id, type: 'ABANDON', ackResult: 'ok' } })) > 0,
        { timeoutMs: 30_000, message: 'ABANDON was not acked ok' },
      );
      expect(hold.attempts()).toBe(1);   // halted at the back-off, not three attempts exhausted
      expect(await sh(world.origin.dir, 'branch', '--list', 'feat/fh')).toBe('');
      expect(await world.job(id)).toMatchObject({ state: 'CRASHED', wipPush: null });
    } finally {
      hold.clear();
    }
  });
});
