/**
 * S1.5 2a end to end: real API + real runner daemon + fake nax. An escalate job raises an ask through the relay; a
 * decision in koda reaches nax's callback; the delivery is recorded; a daemon restart keeps the ask answerable.
 * Run: cd apps/runner && KODA_DB_TESTS=1 bun test test/integration/approval-relay.integration.spec.ts
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createWorld, type TestRunner, type World } from './harness/world';
import { waitFor } from '../helpers/wait';

const enabled = process.env['KODA_DB_TESTS'] === '1';

let world: World;
let runner: TestRunner;

const fakeAsk = (jobId: string): Record<string, unknown> | null => {
  try {
    return JSON.parse(readFileSync(join(runner.jobDir(jobId), 'nax-out', 'fake-ask.json'), 'utf8')) as Record<string, unknown>;
  } catch {
    return null;
  }
};
async function pendingAsk(jobId: string): Promise<{ id: string }> {
  let found: { id: string } | undefined;
  // 1500 ms: the API's global throttle is 100 requests a minute per IP, so an HTTP poll must stay well below 10 Hz.
  await waitFor(async () => { found = (await world.approvals(jobId)).find((a) => a.status === 'pending'); return found !== undefined; }, { timeoutMs: 30_000, intervalMs: 1500 });
  if (!found) throw new Error('unreachable: waitFor resolved but found no pending ask');
  return found;
}

describe.skipIf(!enabled)('approval relay (S1.5 2a)', () => {
  beforeAll(async () => {
    world = await createWorld();
    runner = await world.addRunner('relay');
    await runner.start();
  }, 120_000);
  afterAll(async () => {
    await world?.close();
  });

  test('allow: the decision reaches nax signed, delivery ok, the job completes', async () => {
    await world.withFake({ FAKE_NAX_SCENARIO: 'ask', FAKE_NAX_STEPS: '1' }, async () => {
      const jobId = await world.dispatch({ feature: 'fa', bashMode: 'escalate', approvalTimeoutSec: 60 });
      const ask = await pendingAsk(jobId);
      expect(await world.decide(ask.id, 'allow')).toBe(200);
      await world.waitForJob(jobId, (j) => j.state === 'COMPLETED', 60_000);
      expect(fakeAsk(jobId)).toEqual(expect.objectContaining({ action: 'choose', value: 'allow', respondedBy: 'koda' }));
      await waitFor(async () => (await world.approvals(jobId))[0]?.outcome?.['delivery'] !== undefined, { timeoutMs: 15_000, intervalMs: 1000 });
      expect((await world.approvals(jobId))[0]?.outcome).toEqual({ delivery: expect.objectContaining({ result: 'ok' }) });
    });
  }, 120_000);

  test('deny: nax receives deny', async () => {
    await world.withFake({ FAKE_NAX_SCENARIO: 'ask', FAKE_NAX_STEPS: '1' }, async () => {
      const jobId = await world.dispatch({ feature: 'fb', bashMode: 'gated', approvalTimeoutSec: 60 });
      const ask = await pendingAsk(jobId);
      expect(await world.decide(ask.id, 'deny')).toBe(200);
      await world.waitForJob(jobId, (j) => j.state === 'COMPLETED', 60_000);
      expect(fakeAsk(jobId)).toEqual(expect.objectContaining({ value: 'deny' }));
    });
  }, 120_000);

  test('a daemon restart keeps a pending ask answerable (Review Focus 3)', async () => {
    await world.withFake({ FAKE_NAX_SCENARIO: 'ask', FAKE_NAX_STEPS: '1' }, async () => {
      const jobId = await world.dispatch({ feature: 'fc', bashMode: 'escalate', approvalTimeoutSec: 120 });
      const ask = await pendingAsk(jobId);
      runner.crash();
      await runner.start();                       // READOPT -> watch -> resumeApprovals re-binds port + secret
      expect(await world.decide(ask.id, 'allow')).toBe(200);
      await world.waitForJob(jobId, (j) => j.state === 'COMPLETED', 90_000);
      expect(fakeAsk(jobId)).toEqual(expect.objectContaining({ value: 'allow' }));
    });
  }, 180_000);

  test('a raw job writes no relay overlay and the fake records that it had no webhook', async () => {
    await world.withFake({ FAKE_NAX_SCENARIO: 'ask', FAKE_NAX_STEPS: '1' }, async () => {
      const jobId = await world.dispatch({ feature: 'fd' });
      await world.waitForJob(jobId, (j) => j.state === 'COMPLETED', 60_000);
      expect(fakeAsk(jobId)).toEqual({ skipped: 'no webhook in profile' });
      expect(await world.approvals(jobId)).toEqual([]);
    });
  }, 120_000);
});
