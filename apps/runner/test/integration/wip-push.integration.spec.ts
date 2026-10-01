import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from 'bun:test';
import { git as sh } from '../helpers/git-fixture';
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
    expect(job.resultSha).toBe(await sh(world.origin.dir, 'rev-parse', 'feat/fe'));
  });
});
