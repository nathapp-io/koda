import { afterAll, describe, expect, test } from 'bun:test';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { NaxCapabilityProbe } from '../../src/capabilities/nax-probe';
import { createNaxCli } from '../../src/nax/nax-cli';
import { answerProbe } from '../fixtures/fake-nax-probe';
import { makeTempDirs } from '../helpers/tmp';

const tmp = makeTempDirs();
afterAll(() => tmp.cleanup());
const FAKE = join(import.meta.dir, '..', 'fixtures', 'fake-nax.ts');

async function home() {
  const naxHome = await tmp.make('fakeprobe');
  await mkdir(join(naxHome, 'profiles'), { recursive: true });
  await writeFile(join(naxHome, 'profiles', 'fast.json'), JSON.stringify({ fakeRequirements: { transport: 'native', providers: ['deepseek'], sandbox: true } }));
  await writeFile(join(naxHome, 'profiles', 'broken.json'), JSON.stringify({ fakeError: 'PROFILE_ENV_VAR_UNRESOLVED' }));
  await writeFile(join(naxHome, 'fake-auth.json'), JSON.stringify({ providers: [{ providerId: 'deepseek', stored: { kind: 'api-key', expired: false }, ambient: false, available: true }] }));
  const repo = join(naxHome, 'repo');
  await mkdir(join(repo, '.nax', 'fake-profiles'), { recursive: true });
  await writeFile(join(repo, '.nax', 'fake-profiles', 'needs-zai.json'), JSON.stringify({ fakeRequirements: { transport: 'native', providers: ['zai'], sandbox: false } }));
  return { naxHome, repo, env: { NAX_GLOBAL_CONFIG_DIR: naxHome } };
}
const parsed = (a: { stdout: string } | null) => JSON.parse(a?.stdout ?? 'null');

describe('answerProbe (D108)', () => {
  test('config: no chain is the default requirements; a machine profile and a repo profile answer their fakeRequirements', async () => {
    const h = await home();
    expect(parsed(answerProbe(['config', '-d', h.repo, '--json'], h.env, h.repo)).requirements).toEqual({ agent: 'native', protocol: 'hybrid', transport: 'native', providers: [], sandbox: false });
    expect(parsed(answerProbe(['config', '-d', h.repo, '--profile', 'fast', '--json'], h.env, h.repo)).requirements).toMatchObject({ providers: ['deepseek'], sandbox: true });
    expect(parsed(answerProbe(['config', '-d', h.repo, '--profile', 'fast,needs-zai', '--json'], h.env, h.repo)).requirements).toMatchObject({ providers: ['zai'] });
  });
  test('config: an unknown profile is PROFILE_NOT_FOUND and a fakeError profile is its code, both exit 1', async () => {
    const h = await home();
    expect(answerProbe(['config', '--profile', 'nope', '--json'], h.env, h.repo)).toEqual({ stdout: JSON.stringify({ error: { code: 'PROFILE_NOT_FOUND', message: 'fake-nax: PROFILE_NOT_FOUND' } }), code: 1 });
    expect(parsed(answerProbe(['config', '--profile', 'broken', '--json'], h.env, h.repo)).error.code).toBe('PROFILE_ENV_VAR_UNRESOLVED');
  });
  test('auth list: the stored rows, plus every asked provider without one listed unavailable', async () => {
    const h = await home();
    expect(parsed(answerProbe(['auth', 'list', '--json', 'deepseek', 'zai'], h.env, h.repo))).toEqual({
      source: 'file',
      providers: [
        { providerId: 'deepseek', stored: { kind: 'api-key', expired: false }, ambient: false, available: true },
        { providerId: 'zai', stored: null, ambient: false, available: false },
      ],
    });
  });
  test('sandbox probe: available by default; fake-sandbox.json replaces the document and exits 1 when unavailable', async () => {
    const h = await home();
    expect(answerProbe(['sandbox', 'probe', '--json'], h.env, h.repo)?.code).toBe(0);
    await writeFile(join(h.naxHome, 'fake-sandbox.json'), JSON.stringify({ backend: 'srt', platform: 'linux', available: false, reason: 'bwrap: no userns' }));
    expect(answerProbe(['sandbox', 'probe', '--json'], h.env, h.repo)).toEqual({ stdout: JSON.stringify({ backend: 'srt', platform: 'linux', available: false, reason: 'bwrap: no userns' }), code: 1 });
  });
  test('trust check: trusted by default; the fake-untrusted marker makes every folder untrusted (exit 1)', async () => {
    const h = await home();
    expect(answerProbe(['trust', 'check', '--json', h.repo], h.env, '/')).toEqual({ stdout: JSON.stringify({ root: h.repo, trusted: true, coveredBy: h.repo }), code: 0 });
    await writeFile(join(h.naxHome, 'fake-untrusted'), '');
    expect(answerProbe(['trust', 'check', '--json', h.repo], h.env, '/')?.code).toBe(1);
  });
  test('run, plan and anything without --json are not probe commands', async () => {
    const h = await home();
    expect(answerProbe(['run', '--headless', '--json', '-f', 'x'], h.env, h.repo)).toBeNull();
    expect(answerProbe(['config'], h.env, h.repo)).toBeNull();
  });
});

describe('the fake nax as a real process', () => {
  test('a protected naxCommand wrapper loads service env and validates it during startup/reprobe (#207)', async () => {
    const h = await home();
    const envFile = join(h.naxHome, 'service.env');
    const wrapper = join(h.naxHome, 'nax-service');
    await writeFile(envFile, "KODA_TEST_PLUGIN_TOKEN='private-service-token'\n", { mode: 0o600 });
    await writeFile(wrapper, `#!/bin/sh\nset -eu\nset -a\n. '${envFile}'\nset +a\n: "\${KODA_TEST_PLUGIN_TOKEN:?KODA_TEST_PLUGIN_TOKEN is required in the service env file}"\nexec '${process.execPath}' '${FAKE}' "$@"\n`, { mode: 0o700 });
    const probe = new NaxCapabilityProbe({ nax: createNaxCli([wrapper], h.naxHome), naxHome: h.naxHome, now: () => new Date(0), toolWorks: async () => true });
    expect((await probe.probe()).capabilities.nax.version).toBe('0.83.1-fake');
    await writeFile(envFile, 'unset KODA_TEST_PLUGIN_TOKEN\n');
    await expect(probe.probe()).rejects.toThrow(/KODA_TEST_PLUGIN_TOKEN:.*is required in the service env file/);
  });
  test('--version prints FAKE_NAX_VERSION or 0.83.1-fake; NaxCapabilityProbe reads the fake end to end', async () => {
    const h = await home();
    const { FAKE_NAX_VERSION: _unset, ...env } = process.env;
    const version = Bun.spawnSync(['bun', FAKE, '--version'], { env });
    expect(version.stdout.toString().trim()).toBe('0.83.1-fake');
    const probe = new NaxCapabilityProbe({ nax: createNaxCli(['bun', FAKE], h.naxHome), naxHome: h.naxHome, now: () => new Date(0), toolWorks: async () => true });
    const { capabilities, warnings } = await probe.probe();
    expect(capabilities.nax).toEqual({ version: '0.83.1-fake', protocols: ['native', 'acp'] });
    expect(capabilities.profiles).toEqual({ fast: { protocol: 'native', providers: ['deepseek'], sandbox: true } });
    expect(capabilities.credentials).toEqual([{ providerId: 'deepseek', available: true, stored: { kind: 'api-key', expired: false }, ambient: false }]);
    expect(warnings).toEqual(['profile broken skipped: PROFILE_ENV_VAR_UNRESOLVED']);
  });
});
