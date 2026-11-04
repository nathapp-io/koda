import { afterAll, describe, expect, test } from 'bun:test';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { AssignPayload } from '@nathapp/fleet-protocol';
import { makeTempDirs } from '../../test/helpers/tmp';
import { PathError } from '../paths/safe-segment';
import { waitFor } from '../../test/helpers/wait';
import { buildFixArgv, buildNaxArgv, isProcessAlive, signalGroup, spawnNax } from './nax-process';

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
  test('AC-10 FIX review uses full review and decisions', () => {
    expect(buildNaxArgv(['nax'], assign({ command: 'FIX', jobId: 'j1', profiles: ['native-codex'], review: { prNumber: 4, botLogin: 'koda-fleet[bot]' } }), { decisionsPath: '/decisions.json' })).toEqual(
      ['nax', 'bot', 'review', '4', '--full', '--profile', 'native-codex,koda-job-j1', '--decisions', '/decisions.json'],
    );
  });
  test('AC-13 REVIEW preserves its exact argv without --full', () => {
    expect(buildNaxArgv(['nax'], assign({ command: 'REVIEW', jobId: 'j1', profiles: ['native-codex'], review: { prNumber: 4, botLogin: 'koda-fleet[bot]' } }), { decisionsPath: '/decisions.json' })).toEqual(
      ['nax', 'bot', 'review', '4', '--profile', 'native-codex,koda-job-j1', '--decisions', '/decisions.json'],
    );
  });
  test('AC-9 REVIEW: bot review receives PR number and validated profile chain', () => {
    expect(buildNaxArgv(['nax'], assign({ command: 'REVIEW', jobId: 'j1', profiles: ['native-ds'], review: { prNumber: 42, botLogin: 'koda-fleet[bot]' } }))).toEqual(['nax', 'bot', 'review', '42', '--profile', 'native-ds,koda-job-j1']);
  });
  test('US-005 AC-1: appends the optional decisions path after the profile chain', () => {
    expect(buildNaxArgv(['nax'], assign({ command: 'REVIEW', jobId: 'j1', profiles: ['native-ds'], review: { prNumber: 42, botLogin: 'koda-fleet[bot]' } }), { decisionsPath: '/jobs/j1/review-decisions.json' })).toEqual(
      ['nax', 'bot', 'review', '42', '--profile', 'native-ds,koda-job-j1', '--decisions', '/jobs/j1/review-decisions.json'],
    );
  });
  test('US-005 AC-2: keeps the decisions flag absent for existing two-argument calls', () => {
    expect(buildNaxArgv(['nax'], assign({ command: 'REVIEW', jobId: 'j1', profiles: ['native-ds'], review: { prNumber: 42, botLogin: 'koda-fleet[bot]' } }))).not.toContain('--decisions');
  });
  test('AC-12 RUN preserves its exact argv', () => {
    expect(buildNaxArgv(['nax'], assign({ command: 'RUN', jobId: 'j1', feature: 'auth-flow', profiles: ['native-ds'], maxCostUsd: '5' }))).toEqual(['nax', 'run', '--headless', '--json', '-f', 'auth-flow', '--profile', 'native-ds,koda-job-j1', '--max-cost', '5']);
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

describe('buildFixArgv', () => {
  test('AC-11: builds the fix command with a validated profile chain', () => {
    expect(buildFixArgv(['nax'], assign({ command: 'FIX', jobId: 'j1', profiles: ['native-codex'], review: { prNumber: 4, botLogin: 'koda-fleet[bot]' } }))).toEqual(
      ['nax', 'bot', 'fix', '4', '--no-rereview', '--profile', 'native-codex,koda-job-j1'],
    );
  });
  test('US-003 AC-6 appends --trust for an explicitly trusted FIX', () => {
    expect(buildFixArgv(['nax'], assign({ command: 'FIX', jobId: 'j1', profiles: ['native-codex'], review: { prNumber: 4, botLogin: 'koda-fleet[bot]', trustDetectedChecks: true } }))).toEqual(
      ['nax', 'bot', 'fix', '4', '--no-rereview', '--profile', 'native-codex,koda-job-j1', '--trust'],
    );
  });
  test('US-003 AC-7 omits --trust when trustDetectedChecks is absent', () => {
    expect(buildFixArgv(['nax'], assign({ command: 'FIX', jobId: 'j1', profiles: ['native-codex'], review: { prNumber: 4, botLogin: 'koda-fleet[bot]' } }))).not.toContain('--trust');
  });
  test('AC-12: rejects an invalid review login with PathError invalid review', () => {
    try {
      buildFixArgv(['nax'], assign({ command: 'FIX', review: { prNumber: 4, botLogin: 'koda-fleet' } }));
      throw new Error('expected invalid review to fail');
    } catch (error) {
      expect(error).toBeInstanceOf(PathError);
      expect((error as Error).message).toBe('invalid review');
    }
  });
});

describe('isProcessAlive injected kill', () => {
  test('AC-1: treats EPERM as dead', () => {
    const kill = () => { throw Object.assign(new Error('denied'), { code: 'EPERM' }); };
    expect(isProcessAlive(4242, kill)).toBe(false);
  });
  test('AC-2: treats ESRCH as dead', () => {
    const kill = () => { throw Object.assign(new Error('missing'), { code: 'ESRCH' }); };
    expect(isProcessAlive(4242, kill)).toBe(false);
  });
  test('AC-3: reports live when kill succeeds and checks signal zero', () => {
    const calls: Array<[number, number]> = [];
    expect(isProcessAlive(4242, (pid, signal) => { calls.push([pid, signal]); })).toBe(true);
    expect(calls).toEqual([[4242, 0]]);
  });
  test('AC-4: rejects pid zero without calling kill', () => {
    let called = false;
    expect(isProcessAlive(0, () => { called = true; })).toBe(false);
    expect(called).toBe(false);
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

describe('US-008 rulings argv', () => {
  const fix = assign({ command: 'FIX', review: { prNumber: 4, botLogin: 'fleet[bot]' } });
  test('AC-5 appends rulings after decisions on FIX review', () => {
    expect(buildNaxArgv(['nax'], fix, { decisionsPath: '/decisions', rulingsPath: '/rulings' })).toEqual(['nax', 'bot', 'review', '4', '--full', '--profile', 'fast,strict,koda-job-cj1', '--decisions', '/decisions', '--rulings', '/rulings']);
  });
  test('AC-6 REVIEW ignores rulingsPath', () => {
    expect(buildNaxArgv(['nax'], { ...fix, command: 'REVIEW' }, { rulingsPath: '/rulings' })).toEqual(['nax', 'bot', 'review', '4', '--profile', 'fast,strict,koda-job-cj1']);
  });
  test('AC-7 FIX decision-only argv remains unchanged', () => {
    expect(buildNaxArgv(['nax'], fix, { decisionsPath: '/decisions' })).toEqual(['nax', 'bot', 'review', '4', '--full', '--profile', 'fast,strict,koda-job-cj1', '--decisions', '/decisions']);
  });
});
