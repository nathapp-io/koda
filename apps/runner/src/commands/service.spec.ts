import { describe, expect, test } from 'bun:test';
import { basename, dirname } from 'node:path';
import { APPARMOR_PROFILE_PATH, USERNS_SYSCTL } from '../service/apparmor';
import { LAUNCHD_PLIST_PATH, SYSTEMD_UNIT_PATH, ServiceError, launchdPlist, systemdUnit } from '../service/units';
import { installService, uninstallService, type ExecResult, type InstallOptions, type ServiceDeps } from './service';

const HOME = '/home/koda-runner/.koda-runner';
const WS = `${HOME}/workspace`;
const PATH = '/usr/local/bin:/usr/bin:/bin';
const RUNNER_JSON = JSON.stringify({ serverUrl: 'https://koda.example.com', workspaceRoot: WS });
const ok = (stdout = ''): ExecResult => ({ code: 0, stdout, stderr: '' });

interface World {
  readonly files: Map<string, string>;
  readonly execs: string[][];
  readonly lines: string[];
  readonly state: { trusted: boolean; failing: string | null; owner: number };
  readonly deps: ServiceDeps;
}

function world(over: Partial<ServiceDeps> = {}, files: Record<string, string> = {}): World {
  const state = { trusted: true, failing: null as string | null, owner: 1001 };
  const store = new Map(Object.entries({ [`${HOME}/runner.json`]: RUNNER_JSON, [`${HOME}/identity.json`]: '{}', ...files }));
  const execs: string[][] = [];
  const lines: string[] = [];
  const respond = (argv: readonly string[]): ExecResult => {
    const line = argv.join(' ');
    if (state.failing && line.startsWith(state.failing)) return { code: 1, stdout: '', stderr: `${state.failing}: boom\n` };
    if (line === 'getent passwd koda-runner') return ok('koda-runner:x:1001:1001::/home/koda-runner:/bin/bash\n');
    if (line.startsWith('getent passwd')) return { code: 2, stdout: '', stderr: '' };
    if (line === 'dscl . -read /Users/koda-runner UniqueID NFSHomeDirectory') return ok('NFSHomeDirectory: /Users/koda-runner\nUniqueID: 502\n');
    if (line.startsWith('dscl')) return { code: 56, stdout: '', stderr: 'eDSRecordNotFound' };
    if (line.includes(' trust check --json ')) {
      return { code: state.trusted ? 0 : 1, stdout: JSON.stringify({ root: WS, trusted: state.trusted, coveredBy: state.trusted ? WS : null }), stderr: '' };
    }
    if (line.includes(' trust add ')) {
      state.trusted = true;
      return ok(`Trusted ${WS}\n`);
    }
    return ok();
  };
  const deps: ServiceDeps = {
    platform: 'linux', euid: 0, env: { PATH }, selfCommand: ['/usr/local/bin/koda-runner'],
    exec: async (argv) => { execs.push([...argv]); return respond(argv); },
    readFile: async (path) => store.get(path) ?? null,
    writeFile: async (path, text) => { store.set(path, text); },
    removeFile: async (path) => { store.delete(path); },
    ownerUid: async () => state.owner,
    listDir: async (dir) => [...store.keys()].filter((path) => dirname(path) === dir).map((path) => basename(path)),
    whichOnPath: (command) => (['nax', 'bwrap'].includes(command) ? `/usr/bin/${command}` : null),
    realpath: async (path) => path,
    log: (line) => { lines.push(line); },
    ...over,
  };
  return { files: store, execs, lines, state, deps };
}
const options = (over: Partial<InstallOptions> = {}): InstallOptions => ({ user: 'koda-runner', home: HOME, trustWorkspace: false, applyApparmor: false, print: false, ...over });
const linuxSpec = { user: 'koda-runner', userHome: '/home/koda-runner', runnerHome: HOME, command: ['/usr/local/bin/koda-runner'], path: PATH };

describe('installService on Linux (D105)', () => {
  test('checks the user, trust as that user, writes the unit, then daemon-reload and enable --now', async () => {
    const w = world();
    await installService(options(), w.deps);
    expect(w.files.get(SYSTEMD_UNIT_PATH)).toBe(systemdUnit(linuxSpec));
    expect(w.execs).toEqual([
      ['getent', 'passwd', 'koda-runner'],
      ['sudo', '-u', 'koda-runner', '-H', 'env', `PATH=${PATH}`, 'nax', 'trust', 'check', '--json', WS],
      ['systemctl', 'daemon-reload'],
      ['systemctl', 'enable', '--now', 'koda-runner.service'],
    ]);
    expect(w.lines.join('\n')).toContain('journalctl -u koda-runner -f');
  });
  test('an explicit naxHome in runner.json reaches nax as NAX_GLOBAL_CONFIG_DIR', async () => {
    const w = world({}, { [`${HOME}/runner.json`]: JSON.stringify({ serverUrl: 'https://koda.example.com', workspaceRoot: WS, naxHome: '/srv/nax' }) });
    await installService(options(), w.deps);
    expect(w.execs[1]).toEqual(['sudo', '-u', 'koda-runner', '-H', 'env', `PATH=${PATH}`, 'NAX_GLOBAL_CONFIG_DIR=/srv/nax', 'nax', 'trust', 'check', '--json', WS]);
  });
  test('--print prints the unit and the commands, needs no root, and changes nothing', async () => {
    const w = world({ euid: 501 });
    await installService(options({ print: true }), w.deps);
    expect(w.files.has(SYSTEMD_UNIT_PATH)).toBe(false);
    expect(w.execs).toEqual([['getent', 'passwd', 'koda-runner']]);
    expect(w.lines.join('\n')).toContain('KillMode=process');
    expect(w.lines.join('\n')).toContain('systemctl enable --now koda-runner.service');
  });
  test('D103: an untrusted workspace is refused without --trust-workspace, and trusted with it', async () => {
    const w = world();
    w.state.trusted = false;
    await expect(installService(options(), w.deps)).rejects.toThrow(/--trust-workspace/);
    expect(w.files.has(SYSTEMD_UNIT_PATH)).toBe(false);
    await installService(options({ trustWorkspace: true }), w.deps);
    expect(w.execs).toContainEqual(['sudo', '-u', 'koda-runner', '-H', 'env', `PATH=${PATH}`, 'nax', 'trust', 'add', WS, '--yes']);
    expect(w.files.has(SYSTEMD_UNIT_PATH)).toBe(true);
  });
  test.each([
    ['not root', { deps: { euid: 501 } }, /must run as root/],
    ['a user that does not exist', { opts: { user: 'nobody-here' } }, /does not exist.*docs\/deployment\/runner\.md/s],
    ['no --home', { opts: { home: undefined } }, /--home <dir> is required/],
    ['a home that is not enrolled', { opts: { home: '/home/koda-runner/elsewhere' } }, /not an enrolled runner home/],
    ['nax not on the service PATH', { deps: { whichOnPath: () => null } }, /not on the service PATH/],
  ] as const)('%s is refused and nothing is written', async (_what, setup, message) => {
    const w = world('deps' in setup ? setup.deps : {});
    await expect(installService(options('opts' in setup ? setup.opts : {}), w.deps)).rejects.toThrow(message);
    expect(w.files.has(SYSTEMD_UNIT_PATH)).toBe(false);
  });
  test('a home owned by another user is refused', async () => {
    const w = world();
    w.state.owner = 0;
    await expect(installService(options(), w.deps)).rejects.toThrow(/must be owned by koda-runner/);
  });
  test('an existing unit is refused (uninstall first)', async () => {
    const w = world({}, { [SYSTEMD_UNIT_PATH]: 'old' });
    await expect(installService(options(), w.deps)).rejects.toThrow(/uninstall-service/);
    expect(w.files.get(SYSTEMD_UNIT_PATH)).toBe('old');
  });
  test('Review focus 5: a --home, --binary or --path with a space, quote or .. is refused before anything runs as root', async () => {
    for (const over of [{ home: '/home/koda runner' }, { binary: "/usr/local/bin/k'r" }, { path: '/usr/bin:/opt/../bin' }]) {
      const w = world();
      await expect(installService(options(over), w.deps)).rejects.toBeInstanceOf(ServiceError);
      expect(w.files.has(SYSTEMD_UNIT_PATH)).toBe(false);
      expect(w.execs.filter((argv) => argv[0] !== 'getent')).toEqual([]);
    }
  });
  test('a failing systemctl is a ServiceError carrying its first stderr line', async () => {
    const w = world();
    w.state.failing = 'systemctl enable';
    await expect(installService(options(), w.deps)).rejects.toThrow(/systemctl enable --now koda-runner.service failed: systemctl enable: boom/);
  });
});

describe('installService: AppArmor on Linux (D106)', () => {
  test('restricted without --apply-apparmor: a warning, and the install goes on', async () => {
    const w = world({}, { [USERNS_SYSCTL]: '1\n' });
    await installService(options(), w.deps);
    expect(w.lines.some((line) => line.startsWith('warning:') && line.includes('--apply-apparmor'))).toBe(true);
    expect(w.files.has(APPARMOR_PROFILE_PATH)).toBe(false);
    expect(w.files.has(SYSTEMD_UNIT_PATH)).toBe(true);
  });
  test('with --apply-apparmor: the profile for the real bwrap path is written and loaded before the unit', async () => {
    const w = world({ realpath: async () => '/usr/bin/bwrap' }, { [USERNS_SYSCTL]: '1\n' });
    await installService(options({ applyApparmor: true }), w.deps);
    expect(w.files.get(APPARMOR_PROFILE_PATH)).toContain('profile koda-runner-bwrap /usr/bin/bwrap flags=(unconfined) {');
    const parser = w.execs.findIndex((argv) => argv[0] === 'apparmor_parser');
    expect(w.execs[parser]).toEqual(['apparmor_parser', '-r', APPARMOR_PROFILE_PATH]);
    expect(parser).toBeLessThan(w.execs.findIndex((argv) => argv[0] === 'systemctl'));
  });
  test('another profile already attached to bwrap is refused; nothing is written', async () => {
    const w = world({}, { [USERNS_SYSCTL]: '1\n', '/etc/apparmor.d/bwrap-userns-restrict': 'profile bwrap /usr/bin/bwrap flags=(unconfined) {\n}\n' });
    await expect(installService(options({ applyApparmor: true }), w.deps)).rejects.toThrow(/bwrap-userns-restrict/);
    expect(w.files.has(APPARMOR_PROFILE_PATH)).toBe(false);
    expect(w.files.has(SYSTEMD_UNIT_PATH)).toBe(false);
  });
  test('bwrap missing from the service PATH is refused', async () => {
    const w = world({ whichOnPath: (command) => (command === 'nax' ? '/usr/bin/nax' : null) }, { [USERNS_SYSCTL]: '1\n' });
    await expect(installService(options({ applyApparmor: true }), w.deps)).rejects.toThrow(/bwrap is not on the service PATH/);
  });
});

describe('installService on macOS (D105)', () => {
  test('dscl for the user, the plist, then launchctl bootstrap system', async () => {
    const home = '/Users/koda-runner/.koda-runner';
    const w = world({ platform: 'darwin' }, {
      [`${home}/runner.json`]: JSON.stringify({ serverUrl: 'https://koda.example.com', workspaceRoot: `${home}/workspace` }), [`${home}/identity.json`]: '{}',
    });
    w.state.owner = 502;
    await installService(options({ home }), w.deps);
    expect(w.files.get(LAUNCHD_PLIST_PATH)).toBe(launchdPlist({ user: 'koda-runner', userHome: '/Users/koda-runner', runnerHome: home, command: ['/usr/local/bin/koda-runner'], path: PATH }));
    expect(w.execs.at(-1)).toEqual(['launchctl', 'bootstrap', 'system', LAUNCHD_PLIST_PATH]);
    expect(w.execs.some((argv) => argv[0] === 'apparmor_parser')).toBe(false);
  });
  test('an unsupported platform is refused', async () => {
    await expect(installService(options(), world({ platform: 'win32' }).deps)).rejects.toThrow(/macOS \(launchd\) and Linux \(systemd\)/);
  });
});

describe('uninstallService (D105)', () => {
  test('Linux: disable --now, remove the unit, daemon-reload, and unload and remove our AppArmor profile', async () => {
    const w = world({}, { [SYSTEMD_UNIT_PATH]: 'unit', [APPARMOR_PROFILE_PATH]: '# Written by koda-runner install-service --apply-apparmor.\n' });
    await uninstallService(w.deps);
    expect(w.execs).toEqual([
      ['systemctl', 'disable', '--now', 'koda-runner.service'],
      ['systemctl', 'daemon-reload'],
      ['apparmor_parser', '-R', APPARMOR_PROFILE_PATH],
    ]);
    expect(w.files.has(SYSTEMD_UNIT_PATH)).toBe(false);
    expect(w.files.has(APPARMOR_PROFILE_PATH)).toBe(false);
  });
  test('Linux: an AppArmor file we did not write is left alone', async () => {
    const w = world({}, { [SYSTEMD_UNIT_PATH]: 'unit', [APPARMOR_PROFILE_PATH]: 'someone else\n' });
    await uninstallService(w.deps);
    expect(w.files.get(APPARMOR_PROFILE_PATH)).toBe('someone else\n');
  });
  test('macOS: bootout, then remove the plist; a service that was not loaded is only a note', async () => {
    const w = world({ platform: 'darwin' }, { [LAUNCHD_PLIST_PATH]: 'plist' });
    w.state.failing = 'launchctl bootout';
    await uninstallService(w.deps);
    expect(w.execs).toEqual([['launchctl', 'bootout', 'system/dev.koda.runner']]);
    expect(w.files.has(LAUNCHD_PLIST_PATH)).toBe(false);
    expect(w.lines.some((line) => line.startsWith('note:'))).toBe(true);
  });
  test('not root is refused', async () => {
    await expect(uninstallService(world({ euid: 501 }).deps)).rejects.toThrow(/must run as root/);
  });
});
