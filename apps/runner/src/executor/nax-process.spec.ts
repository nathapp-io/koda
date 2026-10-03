import { afterAll, describe, expect, test } from 'bun:test';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { AssignPayload } from '@nathapp/fleet-protocol';
import { makeTempDirs } from '../../test/helpers/tmp';
import { waitFor } from '../../test/helpers/wait';
import { buildNaxArgv, isProcessAlive, signalGroup, spawnNax } from './nax-process';

const tmp = makeTempDirs();
afterAll(() => tmp.cleanup());
const assign = (over: Partial<AssignPayload> = {}): AssignPayload => ({
  jobId: 'cj1', command: 'RUN', repo: { provider: 'github', owner: 'a', name: 'b', defaultBranch: 'main', cloneUrl: 'x' },
  ref: 'main', feature: 'feat', planFrom: null, profiles: ['fast', 'strict'], maxCostUsd: '5.25', bashMode: 'raw', approvalTimeoutSec: 600, gitIdentity: { name: 'n', email: 'e' }, ...over,
});

describe('buildNaxArgv (S1 spec §5.2 step 4)', () => {
  test('RUN: headless json run with the chain, the job profile last, and the cost cap', () => {
    expect(buildNaxArgv(['nax'], assign())).toEqual(['nax', 'run', '--headless', '--json', '-f', 'feat', '--profile', 'fast,strict,koda-job-cj1', '--max-cost', '5.25']);
  });
  test('PLAN: plan --from <spec> with the same chain rule; naxCommand may have several words', () => {
    expect(buildNaxArgv(['bun', '/x/fake.ts'], assign({ command: 'PLAN', planFrom: 'docs/spec.md', profiles: [] }))).toEqual(
      ['bun', '/x/fake.ts', 'plan', '--from', 'docs/spec.md', '-f', 'feat', '--profile', 'koda-job-cj1'],
    );
  });
  test.each([
    ['a feature with a slash', { feature: 'a/b' }],
    ['a profile with a comma', { profiles: ['a,b'] }],
    ['a profile using the reserved prefix', { profiles: ['koda-job-x'] }],
    ['a bad cost', { maxCostUsd: '5; rm -rf' }],
    ['a cost with 5 decimals', { maxCostUsd: '1.23456' }],
    ['a PLAN without planFrom', { command: 'PLAN' as const, planFrom: null }],
    ['a planFrom with ..', { command: 'PLAN' as const, planFrom: '../x' }],
    ['a job id with a slash', { jobId: 'a/b' }],
  ])('rejects %s', (_label, over) => {
    expect(() => buildNaxArgv(['nax'], assign(over as Partial<AssignPayload>))).toThrow();
  });
});

describe('spawnNax and signalGroup', () => {
  test('spawns detached with its own process group, output going to files, and survives the caller not awaiting it', async () => {
    const dir = await tmp.make('proc');
    const stdoutPath = join(dir, 'out');
    const stderrPath = join(dir, 'err');
    const { pid, pgid } = spawnNax(['sh', '-c', 'echo to-out; echo to-err >&2; sleep 30'], { cwd: dir, stdoutPath, stderrPath, env: { ...process.env } });
    expect(pgid).toBe(pid);
    expect(isProcessAlive(pid)).toBe(true);
    await waitFor(async () => (await readFile(stdoutPath, 'utf8')).includes('to-out') && (await readFile(stderrPath, 'utf8')).includes('to-err'));
    expect(signalGroup(pgid, 'SIGTERM')).toBe(true);
    await waitFor(() => !isProcessAlive(pid));
  });
  test('a group signal reaches grandchildren', async () => {
    const dir = await tmp.make('proc');
    const pidFile = join(dir, 'grandchild.pid');
    const { pid, pgid } = spawnNax(['sh', '-c', `sleep 60 & echo $! > ${pidFile}; wait`], { cwd: dir, stdoutPath: join(dir, 'o'), stderrPath: join(dir, 'e'), env: { ...process.env } });
    await waitFor(async () => (await readFile(pidFile, 'utf8').catch(() => '')).trim().length > 0);
    const grandchild = Number((await readFile(pidFile, 'utf8')).trim());
    expect(isProcessAlive(grandchild)).toBe(true);
    signalGroup(pgid, 'SIGKILL');
    await waitFor(() => !isProcessAlive(pid) && !isProcessAlive(grandchild));
  });
  test('never signals a reserved or malformed group (0, 1, negative, fractional, NaN)', () => {
    for (const bad of [0, 1, -1, -5, 1.5, NaN, Infinity]) expect(signalGroup(bad, 'SIGKILL')).toBe(false);
    expect(isProcessAlive(0)).toBe(false);
    expect(isProcessAlive(-3)).toBe(false);
  });
  test('signalling a dead group is false, not an exception', async () => {
    const dir = await tmp.make('proc');
    const { pid, pgid } = spawnNax(['sh', '-c', 'exit 0'], { cwd: dir, stdoutPath: join(dir, 'o'), stderrPath: join(dir, 'e'), env: { ...process.env } });
    await waitFor(() => !isProcessAlive(pid));
    expect(signalGroup(pgid, 'SIGTERM')).toBe(false);
  });
  test('the environment is exactly what the caller passes', async () => {
    const dir = await tmp.make('proc');
    const { pid } = spawnNax(['sh', '-c', 'echo "$KODA_T:$HOME_SHOULD_NOT_EXIST" > env.txt'], { cwd: dir, stdoutPath: join(dir, 'o'), stderrPath: join(dir, 'e'), env: { PATH: process.env['PATH'], KODA_T: 'yes' } });
    await waitFor(() => !isProcessAlive(pid));
    expect((await readFile(join(dir, 'env.txt'), 'utf8')).trim()).toBe('yes:');
  });
});
