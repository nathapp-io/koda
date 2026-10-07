import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from 'bun:test';
import { createWorld, type EventView, type World } from './harness';

setDefaultTimeout(120_000);
const enabled = process.env['KODA_DB_TESTS'] === '1';
const runnerStates = (events: EventView[]) => events.filter((e) => e.type === 'state').map((e) => (e.payload as { to: string }).to);

describe.skipIf(!enabled)('runner 3b-2 against the real API: capabilities from nax, the post-checkout check', () => {
  let world: World;
  beforeAll(async () => {
    world = await createWorld();
    await (await world.addRunner('caps')).start();
  }, 180_000);
  afterAll(async () => { await world?.close(); });

  test('D95: the runner row carries what nax reported (through enroll and the first sync), accepted by the server validator', async () => {
    const row = await world.prisma.runner.findUniqueOrThrow({ where: { name: 'caps' } });
    expect(row.capabilities).toMatchObject({
      nax: { version: '0.83.1-fake' },
      profiles: { fast: { protocol: 'native', providers: ['deepseek'], sandbox: false } },
      credentials: [{ providerId: 'deepseek', available: true, stored: { kind: 'api-key', expired: false }, ambient: false }],
      sandbox: { available: true },
      tools: { git: true, gh: true },
      executors: ['host'],
      configJobs: true,
    });
  });

  test('D104: a dispatch naming the machine profile passes the check and completes', async () => {
    const id = await world.dispatch({ feature: 'fa', profiles: ['fast'] });
    const job = await world.waitForJob(id, (j) => j.state === 'COMPLETED' || j.state === 'FAILED');
    expect(job).toMatchObject({ state: 'COMPLETED', stateReason: null });
  });

  test('D104: a repo-provided profile needing a provider this machine lacks fails before nax spawns', async () => {
    const id = await world.dispatch({ feature: 'fc', profiles: ['needs-zai'] });
    const job = await world.waitForJob(id, (j) => j.state === 'FAILED');
    expect(job.stateReason).toBe('capability mismatch: provider zai unavailable');
    expect(runnerStates(await world.events(id))).not.toContain('RUNNING');
  });

  test("D104: a profile nobody defines fails with nax's code", async () => {
    const id = await world.dispatch({ feature: 'fd', profiles: ['no-such-profile'] });
    const job = await world.waitForJob(id, (j) => j.state === 'FAILED');
    expect(job.stateReason).toBe('capability mismatch: profile resolve failed (PROFILE_NOT_FOUND)');
  });

  test('#207: a repo-provided profile whose interaction plugin cannot start fails before nax spawns', async () => {
    const id = await world.dispatch({ feature: 'fe', profiles: ['broken-tg'] });
    const job = await world.waitForJob(id, (j) => j.state === 'FAILED');
    expect(job.stateReason).toBe('capability mismatch: interaction telegram (TELEGRAM_NOT_CONFIGURED)');
    expect(runnerStates(await world.events(id))).not.toContain('RUNNING');
  });
});
