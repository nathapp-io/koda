import { afterAll, describe, expect, test } from 'bun:test';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { makeTempDirs } from '../../test/helpers/tmp';
import { ServiceError, launchdPlist, systemdUnit, validateSpec, type ServiceSpec } from './units';

const tmp = makeTempDirs();
afterAll(() => tmp.cleanup());
const SPEC: ServiceSpec = {
  user: 'koda-runner', userHome: '/home/koda-runner', runnerHome: '/home/koda-runner/.koda-runner',
  command: ['/usr/local/bin/koda-runner'], path: '/home/koda-runner/.bun/bin:/usr/local/bin:/usr/bin:/bin',
};

describe('systemdUnit (design §3.3, D105)', () => {
  test('User, KillMode=process, Restart=always, no restart on exit 2, reload is SIGHUP, --home before run', () => {
    expect(systemdUnit(SPEC)).toBe([
      '# Written by koda-runner install-service.',
      '[Unit]',
      'Description=Koda fleet runner',
      'After=network-online.target',
      'Wants=network-online.target',
      '',
      '[Service]',
      'Type=simple',
      'User=koda-runner',
      'WorkingDirectory=/home/koda-runner/.koda-runner',
      'Environment=HOME=/home/koda-runner',
      'Environment=PATH=/home/koda-runner/.bun/bin:/usr/local/bin:/usr/bin:/bin',
      'ExecStart=/usr/local/bin/koda-runner --home /home/koda-runner/.koda-runner run',
      'ExecReload=/bin/kill -HUP $MAINPID',
      '# nax jobs run detached: a stop or restart must leave them running so the next daemon readopts them.',
      'KillMode=process',
      'Restart=always',
      'RestartSec=5',
      '# Exit 2: the server refused this runner (key revoked, protocol too old); a restart cannot fix that.',
      'RestartPreventExitStatus=2',
      '',
      '[Install]',
      'WantedBy=multi-user.target',
      '',
    ].join('\n'));
  });
  test('a runner started from source runs bun with the entry file', () => {
    expect(systemdUnit({ ...SPEC, command: ['/home/u/.bun/bin/bun', '/repo/apps/runner/src/main.ts'] }))
      .toContain('ExecStart=/home/u/.bun/bin/bun /repo/apps/runner/src/main.ts --home /home/koda-runner/.koda-runner run');
  });
});

describe('launchdPlist (design §3.3, D105)', () => {
  const plist = launchdPlist(SPEC);
  test('UserName, AbandonProcessGroup, KeepAlive, the program arguments and the log file', () => {
    for (const fragment of [
      '<key>Label</key>\n  <string>dev.koda.runner</string>',
      '<key>UserName</key>\n  <string>koda-runner</string>',
      '<string>/usr/local/bin/koda-runner</string>\n    <string>--home</string>\n    <string>/home/koda-runner/.koda-runner</string>\n    <string>run</string>',
      '<key>AbandonProcessGroup</key>\n  <true/>',
      '<key>KeepAlive</key>\n  <true/>',
      '<key>RunAtLoad</key>\n  <true/>',
      '<key>ThrottleInterval</key>\n  <integer>10</integer>',
      '<key>HOME</key>\n    <string>/home/koda-runner</string>',
      '<key>PATH</key>\n    <string>/home/koda-runner/.bun/bin:/usr/local/bin:/usr/bin:/bin</string>',
      '<key>StandardErrorPath</key>\n  <string>/home/koda-runner/.koda-runner/runner.log</string>',
    ]) expect(plist).toContain(fragment);
  });
  test.skipIf(process.platform !== 'darwin')('plutil accepts it', async () => {
    const file = join(await tmp.make('plist'), 'dev.koda.runner.plist');
    await writeFile(file, plist);
    const lint = Bun.spawnSync(['plutil', '-lint', file]);
    expect(lint.exitCode).toBe(0);
  });
});

describe('validateSpec (D105, Review focus 5)', () => {
  test('a clean spec passes unchanged', () => {
    expect(validateSpec(SPEC)).toEqual(SPEC);
  });
  test.each([
    ['a user name with a capital', { user: 'Koda' }],
    ['a user name with a space', { user: 'koda runner' }],
    ['a runner home with a space', { runnerHome: '/home/koda runner/.koda-runner' }],
    ['a runner home with ..', { runnerHome: '/home/koda-runner/../root' }],
    ['a relative runner home', { runnerHome: 'koda-runner' }],
    ['a binary with a quote', { command: ["/usr/local/bin/koda'runner"] }],
    ['a binary with a $', { command: ['/usr/local/bin/$HOME'] }],
    ['a PATH with an empty entry', { path: '/usr/bin::/bin' }],
    ['a PATH with a relative entry', { path: '/usr/bin:bin' }],
    ['a PATH with a %', { path: '/usr/%h/bin' }],
    ['no command at all', { command: [] }],
  ])('%s is refused, never escaped', (_what, over) => {
    expect(() => validateSpec({ ...SPEC, ...over } as ServiceSpec)).toThrow(ServiceError);
  });
});
