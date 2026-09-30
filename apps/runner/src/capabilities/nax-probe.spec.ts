import { afterAll, describe, expect, test } from 'bun:test';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { NaxUnavailableError } from '../nax/nax-cli';
import { FakeNaxCli, TIMED_OUT, naxError, type FakeRequirements } from '../../test/helpers/fake-nax-cli';
import { makeTempDirs } from '../../test/helpers/tmp';
import { NaxCapabilityProbe, listProfileNames } from './nax-probe';

const tmp = makeTempDirs();
afterAll(() => tmp.cleanup());
const clock = () => new Date('2026-10-01T00:00:00.000Z');
const NATIVE: FakeRequirements = { transport: 'native', providers: [], sandbox: false };

async function naxHome(profiles: readonly string[]): Promise<string> {
  const home = await tmp.make('probe');
  await mkdir(join(home, 'profiles'), { recursive: true });
  for (const name of profiles) await writeFile(join(home, 'profiles', `${name}.json`), '{}');
  return home;
}

function probeWith(home: string, nax: FakeNaxCli, have: readonly string[] = ['git', 'gh']) {
  const removed: string[] = [];
  const empty = join(home, 'empty');
  const prober = new NaxCapabilityProbe({
    nax, naxHome: home, now: clock, toolWorks: async (command) => have.includes(command),
    makeEmptyDir: async () => {
      await mkdir(empty, { recursive: true });
      return { dir: empty, remove: async () => { removed.push(empty); } };
    },
  });
  return { run: () => prober.probe(), removed, empty };
}

describe('listProfileNames (D98)', () => {
  test('json files only, koda job overlays excluded, sorted by code unit; no profiles dir is empty', async () => {
    const home = await naxHome(['beta', 'Alpha', 'koda-job-cabc', 'alpha2']);   // distinct letters: macOS file names are case-insensitive
    await writeFile(join(home, 'profiles', 'notes.txt'), 'x');
    await mkdir(join(home, 'profiles', 'dir.json'));
    expect(await listProfileNames(home)).toEqual(['Alpha', 'alpha2', 'beta']);
    expect(await listProfileNames(join(home, 'nowhere'))).toEqual([]);
  });
});

describe('NaxCapabilityProbe (design §3.2, D98-D101)', () => {
  test("reports nax's answers: version, ProfileNeeds per profile, needed credentials first, sandbox, protocols and tools", async () => {
    const home = await naxHome(['native-ds', 'cross-agent', 'koda-job-cabc']);
    const nax = new FakeNaxCli({
      version: '0.83.1',
      config: {
        'native-ds': { transport: 'native', providers: ['openrouter', 'minimax'], sandbox: true },
        'cross-agent': { transport: 'acp', providers: [], sandbox: false },
      },
      auth: [
        { providerId: 'anthropic', stored: { kind: 'api-key', expired: false }, ambient: false, available: true },
        { providerId: 'openrouter', stored: { kind: 'api-key', expired: false }, ambient: false, available: true },
      ],
    });
    const { run, removed, empty } = probeWith(home, nax, ['git', 'gh', 'acpx']);
    const { capabilities, warnings } = await run();
    expect(capabilities).toEqual({
      nax: { version: '0.83.1', protocols: ['native', 'acp'] },
      sandbox: { available: true, probedAt: '2026-10-01T00:00:00.000Z' },
      profiles: {
        'cross-agent': { protocol: 'acp', providers: [], sandbox: false },
        'native-ds': { protocol: 'native', providers: ['minimax', 'openrouter'], sandbox: true },
      },
      credentials: [
        { providerId: 'minimax', available: false, stored: null, ambient: false },
        { providerId: 'openrouter', available: true, stored: { kind: 'api-key', expired: false }, ambient: false },
        { providerId: 'anthropic', available: true, stored: { kind: 'api-key', expired: false }, ambient: false },
      ],
      tools: { git: true, gh: true, glab: false },
      executors: ['host'],
    });
    expect(warnings).toEqual([]);
    expect(nax.calls.filter((c) => c.args[0] === 'config').map((c) => c.args)).toEqual([
      ['config', '-d', empty, '--profile', 'cross-agent', '--json'],
      ['config', '-d', empty, '--profile', 'native-ds', '--json'],
    ]);
    expect(nax.calls.every((c) => c.cwd === empty)).toBe(true);
    expect(nax.calls.find((c) => c.args[0] === 'auth')?.args).toEqual(['auth', 'list', '--json', 'minimax', 'openrouter']);
    expect(removed).toEqual([empty]);
  });

  test('Review focus 1: 68 valid profiles report the first 64 by name; a bad name and a failing profile are skipped with warnings', async () => {
    const names = Array.from({ length: 67 }, (_, i) => `p${String(i).padStart(2, '0')}`);
    const home = await naxHome([...names, 'bad name', 'otel']);
    const config = Object.fromEntries(names.map((name) => [name, NATIVE]));
    const nax = new FakeNaxCli({ config: { ...config, otel: naxError('PROFILE_ENV_VAR_UNRESOLVED') } });
    const { capabilities, warnings } = await probeWith(home, nax).run();
    // sorted: otel, p00 ... p66; the first 64 are otel and p00-p62; otel fails
    expect(Object.keys(capabilities.profiles)).toHaveLength(63);
    expect(capabilities.profiles['p62']).toEqual({ protocol: 'native', providers: [], sandbox: false });
    expect(capabilities.profiles['p63']).toBeUndefined();
    expect(capabilities.profiles['otel']).toBeUndefined();
    expect(warnings).toEqual([
      'skipped 1 profile file(s) whose names koda cannot carry: "bad name"',
      'reported the first 64 of 68 profiles by name',
      'profile otel skipped: PROFILE_ENV_VAR_UNRESOLVED',
    ]);
    expect(nax.calls.filter((c) => c.args[0] === 'config')).toHaveLength(64);
  });

  test('a profile needing more than 16 providers, or with a document of another shape, is skipped', async () => {
    const home = await naxHome(['many', 'odd', 'ok']);
    const nax = new FakeNaxCli({
      config: {
        many: { transport: 'native', providers: Array.from({ length: 17 }, (_, i) => `p${i}`), sandbox: false },
        odd: { code: 0, stdout: '{"requirements":{"transport":"hybrid"}}', stderr: '', timedOut: false },
        ok: NATIVE,
      },
    });
    const { capabilities, warnings } = await probeWith(home, nax).run();
    expect(Object.keys(capabilities.profiles)).toEqual(['ok']);
    expect(warnings).toEqual(['profile many skipped: TOO_MANY_PROVIDERS', 'profile odd skipped: NAX_OUTPUT_UNPARSEABLE']);
  });

  test('D99: a failed auth listing reports every needed provider unavailable (never missing) and warns', async () => {
    const home = await naxHome(['fast']);
    const nax = new FakeNaxCli({ config: { fast: { transport: 'native', providers: ['deepseek'], sandbox: false } }, auth: naxError('CREDENTIAL_FILE_UNREADABLE') });
    const { capabilities, warnings } = await probeWith(home, nax).run();
    expect(capabilities.credentials).toEqual([{ providerId: 'deepseek', available: false, stored: null, ambient: false }]);
    expect(warnings).toEqual(['nax auth list failed (CREDENTIAL_FILE_UNREADABLE); needed providers reported unavailable']);
  });

  test('D100, Review focus 2: an unavailable sandbox carries its reason; a timed-out probe is a failure, and the probe still completes', async () => {
    const home = await naxHome([]);
    const reason = 'sandbox could not run a command: bwrap: No permissions to create new namespace';
    const unavailable = await probeWith(home, new FakeNaxCli({ sandbox: { backend: 'srt', platform: 'linux', available: false, reason } })).run();
    expect(unavailable.capabilities.sandbox).toEqual({ available: false, error: reason, probedAt: '2026-10-01T00:00:00.000Z' });
    const timedOut = await probeWith(home, new FakeNaxCli({ sandbox: TIMED_OUT })).run();
    expect(timedOut.capabilities.sandbox).toEqual({ available: false, error: 'nax sandbox probe failed: NAX_TIMEOUT', probedAt: '2026-10-01T00:00:00.000Z' });
    expect(timedOut.capabilities.nax.version).toBe('0.83.1');
  });

  test('no profiles: an empty profile map, and the auth listing asks for no provider', async () => {
    const home = await tmp.make('bare');
    const nax = new FakeNaxCli();
    const { capabilities } = await probeWith(home, nax).run();
    expect(capabilities.profiles).toEqual({});
    expect(nax.calls.find((c) => c.args[0] === 'auth')?.args).toEqual(['auth', 'list', '--json']);
  });

  test('D97: an older nax rejects with NaxUnavailableError, and the empty dir is still removed', async () => {
    const home = await naxHome(['fast']);
    const { run, removed, empty } = probeWith(home, new FakeNaxCli({ version: '0.83.0' }));
    await expect(run()).rejects.toBeInstanceOf(NaxUnavailableError);
    expect(removed).toEqual([empty]);
  });
});
