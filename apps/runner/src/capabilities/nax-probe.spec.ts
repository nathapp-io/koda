import { afterAll, describe, expect, test } from 'bun:test';
import { chmod, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { NaxUnavailableError } from '../nax/nax-cli';
import { FakeNaxCli, TIMED_OUT, naxError, type FakeRequirements } from '../../test/helpers/fake-nax-cli';
import { makeTempDirs } from '../../test/helpers/tmp';
import type { AcpAgentProbe } from './acp-agent-probe';
import { MAX_REPORT_BYTES, NaxCapabilityProbe, listProfileNames } from './nax-probe';

const tmp = makeTempDirs();
afterAll(() => tmp.cleanup());
const clock = () => new Date('2026-10-01T00:00:00.000Z');
const NATIVE: FakeRequirements = { transport: 'native', providers: [], sandbox: false };
const TG_FAILED = { plugin: 'telegram', status: 'failed', code: 'TELEGRAM_NOT_CONFIGURED', message: 'Telegram plugin requires botToken and chatId' };

async function naxHome(profiles: readonly string[]): Promise<string> {
  const home = await tmp.make('probe');
  await mkdir(join(home, 'profiles'), { recursive: true });
  for (const name of profiles) await writeFile(join(home, 'profiles', `${name}.json`), '{}');
  return home;
}

function probeWith(home: string, nax: FakeNaxCli, have: readonly string[] = ['git', 'gh'], acpProbe?: AcpAgentProbe, vaultHelper?: () => Promise<boolean>) {
  const removed: string[] = [];
  const empty = join(home, 'empty');
  const prober = new NaxCapabilityProbe({
    nax, naxHome: home, now: clock, toolWorks: async (command) => have.includes(command),
    ...(acpProbe === undefined ? {} : { acpProbe }),
    ...(vaultHelper === undefined ? {} : { vaultHelper }),
    makeEmptyDir: async () => {
      await mkdir(empty, { recursive: true });
      return { dir: empty, remove: async () => { removed.push(empty); } };
    },
  });
  return { run: () => prober.probe(), removed, empty };
}

describe('US-008 botRulings', () => {
  test('AC-11 advertises rulings only with successful help and token safety', async () => {
    const home = await naxHome([]);
    for (const [stdout, code, timedOut, safe, expected] of [
      ['--decisions --full --rulings', 0, false, true, true],
      ['--decisions --full', 0, false, true, false],
      ['--rulings', 0, false, true, false],
      ['--decisions --rulings', 1, false, true, false],
      ['--decisions --rulings', 0, true, true, false],
      ['--decisions --rulings', 0, false, false, false],
    ] as const) {
      const nax = new FakeNaxCli({ botReview: { code, stdout, stderr: '', timedOut }, k0Version: { code: safe ? 1 : 0, stdout: '0.83.1', stderr: safe ? 'NAX_FORGE_TOKEN is not supported' : '', timedOut: false } });
      const { capabilities } = await probeWith(home, nax).run();
      expect(capabilities.botRulings).toBe(expected ? true : undefined);
    }
  });
});

describe('listProfileNames (D98, D112)', () => {
  test('json files only, koda job overlays excluded, sorted by code unit', async () => {
    const home = await naxHome(['beta', 'Alpha', 'koda-job-cabc', 'alpha2']);   // distinct letters: macOS file names are case-insensitive
    await writeFile(join(home, 'profiles', 'notes.txt'), 'x');
    await mkdir(join(home, 'profiles', 'dir.json'));
    expect(await listProfileNames(home)).toEqual({ names: ['Alpha', 'alpha2', 'beta'], warning: null });
  });
  test('a profiles path that is not a directory is simply no profiles', async () => {
    const home = await tmp.make('notadir');
    await writeFile(join(home, 'profiles'), 'not a directory');
    expect(await listProfileNames(home)).toEqual({ names: [], warning: null });
    expect(await listProfileNames(join(home, 'nowhere'))).toEqual({ names: [], warning: null });
  });
  test.skipIf(process.getuid?.() === 0)('D112: a profiles directory this runner cannot read is a warning, not "no profiles"', async () => {
    const home = await naxHome(['fast']);
    const dir = join(home, 'profiles');
    await chmod(dir, 0o000);
    try {
      expect(await listProfileNames(home)).toEqual({ names: [], warning: expect.stringContaining('cannot read') });
    } finally {
      await chmod(dir, 0o755);   // the temp dir must stay removable
    }
  });
});

describe('NaxCapabilityProbe (design §3.2, D98-D101)', () => {
  test('US-004 AC-9/10: FakeNaxCli defaults remain non-K0 independent of overlays', async () => {
    const nax = new FakeNaxCli();
    expect((await nax.run(['--version'], { cwd: '/tmp', env: { NAX_FORGE_TOKEN: 'probe' } })).code).toBe(0);
    const help = await nax.run(['bot', 'review', '--help'], { cwd: '/tmp' });
    expect(JSON.parse(help.stdout)).toMatchObject({ error: { code: 'UNKNOWN_COMMAND' } });
  });
  test('US-004: advertises K0 only when bot review exists and rejects ambient token env', async () => {
    const home = await naxHome([]);
    const unsupported = { code: 1, stdout: '', stderr: 'NAX_FORGE_TOKEN is not supported', timedOut: false };
    const nax = new FakeNaxCli({ botReview: { code: 0, stdout: '--decisions <path>  Caller decisions file', stderr: '', timedOut: false }, k0Version: unsupported });
    const { capabilities } = await probeWith(home, nax).run();
    expect(capabilities.botReview).toBe(true);
    expect(nax.calls.find((call) => call.args[0] === '--version' && call.env?.['NAX_FORGE_TOKEN'] === 'probe')).toBeDefined();
  });

  test('US-006 AC-1: reports botFix only when full review and no-rereview fix are supported', async () => {
    const home = await naxHome([]);
    const nax = new FakeNaxCli({ botReview: { code: 0, stdout: '--decisions --full', stderr: '', timedOut: false }, botFix: { code: 0, stdout: '--no-rereview', stderr: '', timedOut: false }, k0Version: { code: 1, stdout: '', stderr: 'NAX_FORGE_TOKEN is not supported', timedOut: false } });
    const { capabilities } = await probeWith(home, nax).run();
    expect(capabilities).toMatchObject({ botReview: true, botFix: true });
  });

  test('US-006 AC-2/3: omits botFix unless fix help succeeds and lists no-rereview', async () => {
    const home = await naxHome([]);
    for (const botFix of [{ code: 0, stdout: 'usage fix', stderr: '', timedOut: false }, { code: 1, stdout: '--no-rereview', stderr: '', timedOut: false }]) {
      const nax = new FakeNaxCli({ botReview: { code: 0, stdout: '--decisions --full', stderr: '', timedOut: false }, botFix, k0Version: { code: 1, stdout: '', stderr: 'NAX_FORGE_TOKEN is not supported', timedOut: false } });
      expect('botFix' in (await probeWith(home, nax).run()).capabilities).toBe(false);
    }
  });

  test('US-006 AC-4/5: requires --full and does not probe fix when review support fails', async () => {
    const home = await naxHome([]);
    const common = { code: 1, stdout: '', stderr: 'NAX_FORGE_TOKEN is not supported', timedOut: false };
    const lacksFull = new FakeNaxCli({ botReview: { code: 0, stdout: '--decisions', stderr: '', timedOut: false }, k0Version: common });
    expect((await probeWith(home, lacksFull).run()).capabilities).toMatchObject({ botReview: true });
    expect('botFix' in (await probeWith(home, lacksFull).run()).capabilities).toBe(false);
    const failed = new FakeNaxCli({ botReview: { code: 1, stdout: '--decisions --full', stderr: '', timedOut: false }, k0Version: common });
    await probeWith(home, failed).run();
    expect(failed.calls.some((c) => c.args.join(' ') === 'bot fix --help')).toBe(false);
  });

  test('US-005 AC-3: advertises botReview only with decisions help and the ambient-token safety check', async () => {
    const home = await naxHome([]);
    const unsupported = { code: 1, stdout: '', stderr: 'NAX_FORGE_TOKEN is not supported', timedOut: false };
    const nax = new FakeNaxCli({ botReview: { code: 0, stdout: 'usage --decisions <path>', stderr: '', timedOut: false }, k0Version: unsupported });
    const { capabilities } = await probeWith(home, nax).run();
    expect(capabilities.botReview).toBe(true);
    expect(nax.calls).toContainEqual(expect.objectContaining({ args: ['--version'], env: { NAX_FORGE_TOKEN: 'probe' } }));
  });

  test('US-005 AC-4: omits botReview when review help lacks decisions despite the safety check', async () => {
    const home = await naxHome([]);
    const unsupported = { code: 1, stdout: '', stderr: 'NAX_FORGE_TOKEN is not supported', timedOut: false };
    const nax = new FakeNaxCli({ botReview: { code: 0, stdout: 'usage: nax bot review <pr>', stderr: '', timedOut: false }, k0Version: unsupported });
    const { capabilities } = await probeWith(home, nax).run();
    expect('botReview' in capabilities).toBe(false);
  });

  test('US-004: omits K0 when version accepts the probe token or bot review is unavailable', async () => {
    const home = await naxHome([]);
    const accepted = await probeWith(home, new FakeNaxCli({ k0Version: { code: 0, stdout: '0.83.1', stderr: '', timedOut: false }, botReview: { code: 0, stdout: '', stderr: '', timedOut: false } })).run();
    expect('botReview' in accepted.capabilities).toBe(false);
    const unavailable = await probeWith(home, new FakeNaxCli({ botReview: { code: 1, stdout: '', stderr: '', timedOut: false }, k0Version: { code: 1, stdout: '', stderr: 'NAX_FORGE_TOKEN is not supported', timedOut: false } })).run();
    expect('botReview' in unavailable.capabilities).toBe(false);
  });

  test('US-006 AC-11: the capability report advertises thread mode execution', async () => {
    const home = await naxHome([]);
    const { capabilities } = await probeWith(home, new FakeNaxCli()).run();
    expect(capabilities.threadModes).toBe(true);
  });

  test('US-007 AC-4: the report advertises workspaceThreads', async () => {
    const home = await naxHome(['fast']);
    const { capabilities } = await probeWith(home, new FakeNaxCli({ config: { fast: NATIVE } })).run();
    expect(capabilities.workspaceThreads).toBe(true);
  });

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
      threadBackends: { native: [], acp: [] },
      tools: { git: true, gh: true, glab: false },
      executors: ['host'],
      configJobs: true,
      threadWrite: true,
      threadModes: true,
      projectThreads: true,
      workspaceThreads: true,
      kodaTools: true,
      projectCode: true,
      approvals: { relay: true },
    });
    expect(warnings).toEqual([]);
    const configCalls = nax.calls.filter((c) => c.args[0] === 'config');
    expect(configCalls.filter((c) => c.args.includes('--profile')).map((c) => c.args)).toEqual([
      ['config', '-d', empty, '--profile', 'cross-agent', '--json'],
      ['config', '-d', empty, '--profile', 'native-ds', '--json'],
    ]);
    expect(configCalls.filter((c) => !c.args.includes('--profile')).map((c) => c.args)).toEqual([['config', '-d', empty, '--json']]);
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
    expect(nax.calls.filter((c) => c.args[0] === 'config' && c.args.includes('--profile'))).toHaveLength(64);
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
  test.skipIf(process.getuid?.() === 0)('D112: an unreadable profiles directory warns and reports no profiles, rather than answering silently', async () => {
    const home = await naxHome(['fast']);
    const dir = join(home, 'profiles');
    await chmod(dir, 0o000);
    try {
      const { capabilities, warnings } = await probeWith(home, new FakeNaxCli()).run();
      expect(capabilities.profiles).toEqual({});
      expect(warnings).toEqual([expect.stringContaining('cannot read')]);
    } finally {
      await chmod(dir, 0o755);   // the temp dir must stay removable
    }
  });
  test('D113: the report never exceeds the server\'s 64 KiB cap; the least load-bearing entries are dropped, with a warning', async () => {
    const names = Array.from({ length: 64 }, (_, i) => `p${String(i).padStart(2, '0')}`);
    const config = Object.fromEntries(names.map((name, i) => [name, {
      transport: 'native' as const, providers: Array.from({ length: 16 }, (_, j) => `${'x'.repeat(50)}${i}-${j}`), sandbox: true,
    }]));
    const { capabilities, warnings } = await probeWith(await naxHome(names), new FakeNaxCli({ config })).run();
    expect(Buffer.byteLength(JSON.stringify(capabilities), 'utf8')).toBeLessThanOrEqual(65_536);
    expect(warnings.some((warning) => warning.includes('65536'))).toBe(true);
    // The kept profiles stay a prefix of the sorted names, so the report does not flicker between probes.
    const kept = Object.keys(capabilities.profiles);
    expect(kept.length).toBeLessThan(64);
    expect(names.slice(0, kept.length)).toEqual(kept);
  });
});

describe('NaxCapabilityProbe ACP agents (thread-agents-modes US-002)', () => {
  const OFFERS = [
    { agent: 'claude' as const, launchable: true, loggedIn: true, models: ['claude-sonnet-4-5'], efforts: ['high'] },
    { agent: 'codex' as const, launchable: true, loggedIn: false, models: [], efforts: [] },
  ];

  test('AC-10: an injected probe reports its logged-in agents in acp and keeps every offer', async () => {
    const home = await naxHome([]);
    const { capabilities } = await probeWith(home, new FakeNaxCli(), ['git', 'gh'], async () => OFFERS).run();
    expect(capabilities.threadBackends).toEqual({ native: [], acp: ['claude'], acpOffers: OFFERS });
  });

  test('AC-10: an agent that is not launchable is never in acp, however logged in it claims to be', async () => {
    const home = await naxHome([]);
    const offers = [
      { agent: 'cursor' as const, launchable: false, loggedIn: true, models: [], efforts: [] },
      { agent: 'codex' as const, launchable: true, loggedIn: null, models: [], efforts: [] },
    ];
    const { capabilities } = await probeWith(home, new FakeNaxCli(), ['git', 'gh'], async () => offers).run();
    expect(capabilities.threadBackends?.acp).toEqual([]);
    expect(capabilities.threadBackends?.acpOffers).toEqual(offers);
  });

  test('AC-11: without an injected probe acp stays empty and no acpOffers key is reported', async () => {
    const home = await naxHome([]);
    const { capabilities } = await probeWith(home, new FakeNaxCli()).run();
    expect(capabilities.threadBackends).toEqual({ native: [], acp: [] });
    expect('acpOffers' in (capabilities.threadBackends ?? {})).toBe(false);
  });

  test('AC-12: a probe that throws reports no ACP agents, no acpOffers and a warning', async () => {
    const home = await naxHome([]);
    const failing: AcpAgentProbe = async () => {
      throw new Error('the agent probe exploded');
    };
    const { capabilities, warnings } = await probeWith(home, new FakeNaxCli(), ['git', 'gh'], failing).run();
    expect(capabilities.threadBackends).toEqual({ native: [], acp: [] });
    expect('acpOffers' in (capabilities.threadBackends ?? {})).toBe(false);
    expect(warnings).toEqual(['ACP agent probe failed (the agent probe exploded); no ACP agents reported']);
  });

  test('the probe and the nax scans overlap, so a slow agent does not serialise the report', async () => {
    const home = await naxHome([]);
    const nax = new FakeNaxCli();
    let probedWhileNaxRan = false;
    const { capabilities } = await probeWith(home, nax, ['git', 'gh'], async () => {
      probedWhileNaxRan = nax.calls.length > 0;
      return OFFERS;
    }).run();
    expect(probedWhileNaxRan).toBe(true);
    expect(capabilities.threadBackends?.acp).toEqual(['claude']);
  });
});

describe('NaxCapabilityProbe interaction checks (#207 spec §3.2)', () => {
  test('a failing base config is reported as capabilities.interaction and warned once, with the message', async () => {
    const home = await naxHome(['fast']);
    const nax = new FakeNaxCli({ config: { default: { ...NATIVE, interaction: TG_FAILED }, fast: NATIVE } });
    const { capabilities, warnings } = await probeWith(home, nax).run();
    expect(capabilities.interaction).toEqual({ ok: false, plugin: 'telegram', code: 'TELEGRAM_NOT_CONFIGURED' });
    expect(capabilities.profiles['fast']).toEqual({ protocol: 'native', providers: [], sandbox: false });
    expect(warnings).toEqual(['interaction telegram failed for the base config: TELEGRAM_NOT_CONFIGURED (Telegram plugin requires botToken and chatId)']);
  });

  test('a failing profile stays in the report, marked, with a warning; an ok profile carries ok', async () => {
    const home = await naxHome(['broken', 'fine']);
    const nax = new FakeNaxCli({
      config: {
        default: { ...NATIVE, interaction: { plugin: null, status: 'skipped' } },
        broken: { ...NATIVE, interaction: { plugin: 'webhook', status: 'failed', code: 'WEBHOOK_URL_MISSING' } },
        fine: { ...NATIVE, interaction: { plugin: 'telegram', status: 'ok' } },
      },
    });
    const { capabilities, warnings } = await probeWith(home, nax).run();
    expect(capabilities.interaction).toEqual({ ok: true, plugin: null });
    expect(capabilities.profiles).toEqual({
      broken: { protocol: 'native', providers: [], sandbox: false, interaction: { ok: false, plugin: 'webhook', code: 'WEBHOOK_URL_MISSING' } },
      fine: { protocol: 'native', providers: [], sandbox: false, interaction: { ok: true, plugin: 'telegram' } },
    });
    expect(warnings).toEqual(['interaction webhook failed for profile broken: WEBHOOK_URL_MISSING']);
  });

  test('an older nax (no interaction field) reports nothing and warns nothing', async () => {
    const home = await naxHome(['fast']);
    const { capabilities, warnings } = await probeWith(home, new FakeNaxCli({ config: { fast: NATIVE } })).run();
    expect('interaction' in capabilities).toBe(false);
    expect('interaction' in (capabilities.profiles['fast'] ?? {})).toBe(false);
    expect(warnings).toEqual([]);
  });

  test('a base config nax cannot resolve leaves the field absent and warns', async () => {
    const home = await naxHome([]);
    const { capabilities, warnings } = await probeWith(home, new FakeNaxCli({ config: { default: naxError('CONFIG_INVALID') } })).run();
    expect('interaction' in capabilities).toBe(false);
    expect(warnings).toEqual(['base config resolve failed (CONFIG_INVALID)']);
  });

  test('the nax message is sanitized before it reaches a warning', async () => {
    const home = await naxHome([]);
    const leaky = { ...TG_FAILED, message: 'bad token=abc123secret' };
    const { warnings } = await probeWith(home, new FakeNaxCli({ config: { default: { ...NATIVE, interaction: leaky } } })).run();
    expect(warnings).toEqual(['interaction telegram failed for the base config: TELEGRAM_NOT_CONFIGURED (bad token=[redacted])']);
  });
});

describe('NaxCapabilityProbe provider vault (C10 US-010)', () => {
  test('AC-8: a vaultHelper resolving true reports providerVault: true', async () => {
    const home = await naxHome([]);
    const { capabilities } = await probeWith(home, new FakeNaxCli(), ['git', 'gh'], undefined, async () => true).run();
    expect(capabilities.providerVault).toBe(true);
  });

  test('AC-8: a vaultHelper resolving false reports no providerVault at all', async () => {
    const home = await naxHome([]);
    const { capabilities } = await probeWith(home, new FakeNaxCli(), ['git', 'gh'], undefined, async () => false).run();
    expect('providerVault' in capabilities).toBe(false);
  });

  test('AC-9: with no vaultHelper providerVault is omitted', async () => {
    const home = await naxHome([]);
    const { capabilities } = await probeWith(home, new FakeNaxCli()).run();
    expect('providerVault' in capabilities).toBe(false);
  });

  test('AC-10: removing providerVault from a vaultHelper report yields exactly the report probed without one', async () => {
    const home = await naxHome(['fast']);
    const nax = new FakeNaxCli({ version: '0.83.1', config: { fast: { transport: 'native', providers: ['openrouter'], sandbox: true } } });
    const withHelper = await probeWith(home, nax, ['git', 'gh'], undefined, async () => true).run();
    const { providerVault, ...rest } = withHelper.capabilities;
    expect(providerVault).toBe(true);
    const without = await probeWith(home, nax).run();
    expect(rest).toEqual(without.capabilities);
    expect(withHelper.warnings).toEqual(without.warnings);
    // The one difference is the flag: every other field is still the one this machine reports.
    expect(rest).toEqual({
      nax: { version: '0.83.1', protocols: ['native'] },
      sandbox: { available: true, probedAt: '2026-10-01T00:00:00.000Z' },
      profiles: { fast: { protocol: 'native', providers: ['openrouter'], sandbox: true } },
      credentials: [{ providerId: 'openrouter', available: false, stored: null, ambient: false }],
      threadBackends: { native: [], acp: [] },
      tools: { git: true, gh: true, glab: false },
      executors: ['host'],
      configJobs: true,
      threadWrite: true,
      threadModes: true,
      projectThreads: true,
      workspaceThreads: true,
      kodaTools: true,
      projectCode: true,
      approvals: { relay: true },
    });
  });

  test('AC-10 regression: the flag\'s bytes are reserved in the byte budget, so enabling it never sheds another capability', async () => {
    const FLAG_BYTES = Buffer.byteLength(JSON.stringify({ providerVault: true }), 'utf8') - 1;   // the property plus its comma
    const NAMES = Array.from({ length: 64 }, (_, i) => `p${String(i).padStart(2, '0')}`);
    const PER_PROFILE = 16;
    // The first 64 needed providers are also the 64 credentials the report lists; padding those would grow both
    // halves of the report, so the padding goes into profiles 4-63 only, one report byte per padding byte.
    const PAD_START = 4 * PER_PROFILE;
    const PAD_SLOTS = NAMES.length * PER_PROFILE - PAD_START;
    const config = (padding: number): Record<string, FakeRequirements> => {
      const each = Math.floor(padding / PAD_SLOTS);
      const extra = padding % PAD_SLOTS;
      return Object.fromEntries(NAMES.map((name, i) => [name, {
        transport: 'native' as const, sandbox: true,
        providers: Array.from({ length: PER_PROFILE }, (_, j) => {
          const slot = i * PER_PROFILE + j;
          const grow = slot < PAD_START ? 0 : each + (slot - PAD_START < extra ? 1 : 0);
          return `${name}-${j}-${'x'.repeat(40 + grow)}`;
        }),
      }]));
    };
    const report = async (padding: number, vaultHelper?: () => Promise<boolean>) =>
      (await probeWith(await naxHome(NAMES), new FakeNaxCli({ config: config(padding) }), ['git', 'gh'], undefined, vaultHelper).run()).capabilities;

    // Land the untrimmed report six bytes under the cap without the flag, so the flag alone is what pushes it over.
    const base = await report(0);
    const padding = MAX_REPORT_BYTES - 6 - Buffer.byteLength(JSON.stringify(base), 'utf8');
    const without = await report(padding);
    const withFlag = await report(padding, async () => true);

    expect(padding).toBeGreaterThan(0);
    expect(Buffer.byteLength(JSON.stringify(without), 'utf8')).toBeLessThanOrEqual(MAX_REPORT_BYTES);
    expect(Buffer.byteLength(JSON.stringify(withFlag), 'utf8')).toBeLessThanOrEqual(MAX_REPORT_BYTES);
    expect(FLAG_BYTES).toBeGreaterThan(0);
    // Both are trimmed (the reserved flag's bytes are what make the fixture over the cap) and neither trims more.
    expect(Object.keys(without.profiles).length).toBe(NAMES.length - 1);
    expect(Object.keys(withFlag.profiles)).toEqual(Object.keys(without.profiles));
    const { providerVault, ...rest } = withFlag;
    expect(providerVault).toBe(true);
    expect(rest).toEqual(without);
  });

  test('a vaultHelper that throws claims nothing and says why, rather than reporting "vault off"', async () => {
    const home = await naxHome([]);
    const { capabilities, warnings } = await probeWith(home, new FakeNaxCli(), ['git', 'gh'], undefined, async () => {
      throw new Error('config.json is not valid JSON');
    }).run();
    expect('providerVault' in capabilities).toBe(false);
    expect(warnings).toEqual(['vault helper check failed (config.json is not valid JSON); provider keys are reported as not served']);
  });
});
