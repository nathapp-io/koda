import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from 'bun:test';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { isProcessAlive } from '../../src/executor/nax-process';
import { git as sh } from '../helpers/git-fixture';
import { waitFor } from '../helpers/wait';
import { createWorld, type EventView, type TestRunner, type World } from './harness';

setDefaultTimeout(120_000);
const enabled = process.env['KODA_DB_TESTS'] === '1';

const runnerStates = (events: EventView[]) => events.filter((e) => e.type === 'state').map((e) => (e.payload as { to: string }).to);
const inOrder = (all: string[], wanted: string[]) => wanted.every((s, i) => all.indexOf(s) >= 0 && (i === 0 || all.indexOf(s) > all.indexOf(wanted[i - 1])));

async function tarNames(bytes: Uint8Array): Promise<{ names: string[]; read: (path: string) => Promise<string> }> {
  const dir = await mkdtemp(join(tmpdir(), 'koda-bundle-'));
  const file = join(dir, 'bundle.tar.gz');
  await writeFile(file, bytes);
  const list = Bun.spawn(['tar', '-tzf', file], { stdout: 'pipe' });
  const names = (await new Response(list.stdout).text()).split('\n').filter(Boolean);
  const read = async (path: string) => {
    const proc = Bun.spawn(['tar', '-xzOf', file, path], { stdout: 'pipe' });
    return new Response(proc.stdout).text();
  };
  return { names, read };
}

describe.skipIf(!enabled)('runner 3a against the real API: RUN, PLAN, cancel', () => {
  let world: World;
  let runner: TestRunner;
  beforeAll(async () => {
    world = await createWorld();
    runner = await world.addRunner('run-plan');
    await runner.start();
  }, 180_000);
  afterAll(async () => { await world?.close(); });

  test('RUN happy path: branch from the PRD, verdict from status.json, result fields, ordered timeline, downloadable bundle, no secrets', async () => {
    const id = await world.dispatch({ feature: 'fa' });
    const job = await world.waitForJob(id, (j) => j.state === 'COMPLETED');
    expect(job).toMatchObject({ finishResult: 'opened', resultPrUrl: 'https://example.test/koda/pull/1', resultBranch: 'feat/fa', stateReason: null });
    expect(job.naxRunId).toMatch(/^run-/);
    expect(job.naxLogRunId).toMatch(/^log-/);
    expect(job.naxCostRunId).toMatch(/^cost-/);
    expect(Number(job.costSpentUsd)).toBeGreaterThan(0);

    const remoteTip = await sh(world.origin.dir, 'rev-parse', 'feat/fa');
    expect(job.resultSha).toBe(remoteTip);
    expect(await sh(world.origin.dir, 'rev-parse', 'feat/fa~1')).toBe(await sh(world.origin.dir, 'rev-parse', 'main'));
    expect(await sh(world.origin.dir, 'log', '-1', '--format=%s', 'feat/fa')).toContain('fake story work');

    const events = await world.events(id);
    expect(inOrder(runnerStates(events), ['ASSIGNED', 'RUNNING', 'UPLOADING', 'COMPLETED'])).toBe(true);
    expect(events.some((e) => e.type === 'snapshot')).toBe(true);
    expect(events.some((e) => e.type === 'log' && (e.payload as { stream: string }).stream === 'run')).toBe(true);
    const seqs = events.filter((e) => e.runnerSeq !== null).map((e) => e.runnerSeq);
    expect(seqs).toEqual([...seqs].sort((a, b) => (a as number) - (b as number)));

    const bundle = await world.downloadBundle(id);
    expect(bundle.status).toBe(200);
    const { names, read } = await tarNames(bundle.bytes);
    expect(names).toEqual(expect.arrayContaining(['bundle-manifest.json', 'nax-out/status.json', 'nax-out/metrics.json', 'nax.stdout', 'nax.stderr']));
    expect(names.some((n) => n.includes('prompt-audit'))).toBe(false);
    expect(JSON.parse(await read('nax-out/status.json')).run.status).toBe('completed');

    const identity = await runner.identity();
    const journalBytes = await runner.journalBytes();                   // journal.db, -wal and -shm: recent rows live in the WAL (D73)
    expect(journalBytes.length).toBeGreaterThan(0);
    expect(journalBytes.includes(Buffer.from(identity.apiKey))).toBe(false);
    expect(JSON.stringify(runner.log.lines)).not.toContain(identity.apiKey);
    expect(world.api.output()).not.toContain(identity.apiKey);
  });

  test('PLAN commits and pushes the plan outputs onto the PRD branch; a follow-up RUN on that branch continues it (R-3.3, R-3.4)', async () => {
    const planId = await world.dispatch({ feature: 'fb', command: 'PLAN', planFrom: 'docs/spec.md' });
    const plan = await world.waitForJob(planId, (j) => j.state === 'COMPLETED');
    expect(plan).toMatchObject({ resultBranch: 'feat/fb' });
    const planTip = await sh(world.origin.dir, 'rev-parse', 'feat/fb');
    expect(plan.resultSha).toBe(planTip);
    const tree = (await sh(world.origin.dir, 'ls-tree', '-r', '--name-only', 'feat/fb')).split('\n');
    expect(tree).toEqual(expect.arrayContaining(['.nax/features/fb/prd.json', '.nax/features/fb/spec.md', '.nax/features/fb/prd-fidelity-report.md', '.nax/features/fb/acceptance-meta.json']));
    expect(tree.some((p) => p.includes('/plan/') || p.includes('/sessions/') || p.includes('prd.rejected.json'))).toBe(false);
    const newPrd = JSON.parse(await sh(world.origin.dir, 'show', 'feat/fb:.nax/features/fb/prd.json'));
    expect(newPrd.userStories[0].id).toBe('US-001');                  // the stale OLD-1 PRD did not pass the verdict
    expect(await sh(world.origin.dir, 'log', '-1', '--format=%s', 'feat/fb')).toBe(`chore(plan): fb PRD via koda job ${planId}`);
    const bundle = await world.downloadBundle(planId);
    expect((await tarNames(bundle.bytes)).names).toContain('plan-logs/plan-1.jsonl');

    const runId = await world.dispatch({ feature: 'fb', ref: 'feat/fb' });
    const run = await world.waitForJob(runId, (j) => j.state === 'COMPLETED');
    expect(run.resultBranch).toBe('feat/fb');
    expect(await sh(world.origin.dir, 'rev-parse', 'feat/fb~1')).toBe(planTip);   // the run continued the plan's branch
    expect(run.resultSha).toBe(await sh(world.origin.dir, 'rev-parse', 'feat/fb'));
  });

  test('cancel: SIGTERM reaches the process group, the partial bundle is uploaded, the job ends CANCELLED', async () => {
    const id = await world.withFake({ FAKE_NAX_SCENARIO: 'hang' }, async () => {
      const jobId = await world.dispatch({ feature: 'fc' });
      await world.waitForJob(jobId, (j) => j.state === 'RUNNING' && j.naxRunId !== null);
      return jobId;
    });
    const pid = runner.daemon?.journal.getJob(id, 1)?.pid as number;
    expect(isProcessAlive(pid)).toBe(true);
    await world.cancel(id);
    const job = await world.waitForJob(id, (j) => j.state === 'CANCELLED');
    expect(job.cancelRequestedAt).not.toBeNull();
    await waitFor(() => !isProcessAlive(pid));
    expect(runnerStates(await world.events(id))).toEqual(expect.arrayContaining(['RUNNING', 'UPLOADING', 'CANCELLED']));
    const bundle = await world.downloadBundle(id);
    expect(bundle.status).toBe(200);
    expect((await tarNames(bundle.bytes)).names).toContain('nax-out/status.json');
    expect(await world.prisma.fleetCommand.count({ where: { jobId: id, type: 'CANCEL', ackResult: 'ok' } })).toBe(1);
  });
});
