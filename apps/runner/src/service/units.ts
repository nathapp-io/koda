export const SYSTEMD_UNIT = 'koda-runner.service';
export const SYSTEMD_UNIT_PATH = '/etc/systemd/system/koda-runner.service';
export const LAUNCHD_LABEL = 'dev.koda.runner';
export const LAUNCHD_PLIST_PATH = '/Library/LaunchDaemons/dev.koda.runner.plist';

export interface ServiceSpec {
  readonly user: string;
  readonly userHome: string;
  readonly runnerHome: string;
  /** How to run this runner (D84 `selfCommand`): the compiled binary, or bun plus the entry file. */
  readonly command: readonly string[];
  readonly path: string;
}

export class ServiceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ServiceError';
  }
}

const USER_NAME = /^[a-z_][a-z0-9_-]{0,31}$/;
const SAFE_PATH = /^\/[A-Za-z0-9._/+-]*$/;

export function assertUserName(user: string): void {
  if (!USER_NAME.test(user)) throw new ServiceError(`${JSON.stringify(user)} is not a valid user name (lowercase letters, digits, _ and -)`);
}

export function assertSafePath(what: string, path: string): void {
  if (!SAFE_PATH.test(path) || path.split('/').includes('..')) {
    throw new ServiceError(`${what} ${JSON.stringify(path)} must be an absolute path of letters, digits and . _ / + - only (no spaces, quotes or ..)`);
  }
}

/** D105: refused, never escaped: a systemd unit and a plist would need two quoting schemes. */
export function validateSpec(spec: ServiceSpec): ServiceSpec {
  assertUserName(spec.user);
  assertSafePath('the user home', spec.userHome);
  assertSafePath('--home', spec.runnerHome);
  if (spec.command.length === 0) throw new ServiceError('the runner binary is required');
  for (const part of spec.command) assertSafePath('the runner binary', part);
  const entries = spec.path.split(':');
  if (entries.some((entry) => entry === '')) throw new ServiceError('--path must be a list of absolute directories with no empty entry');
  for (const entry of entries) assertSafePath('the --path entry', entry);
  return spec;
}

/** Commander reads the program's `--home` only before the subcommand. */
const programArguments = (spec: ServiceSpec): string[] => [...spec.command, '--home', spec.runnerHome, 'run'];

export function systemdUnit(spec: ServiceSpec): string {
  return [
    '# Written by koda-runner install-service.',
    '[Unit]',
    'Description=Koda fleet runner',
    'After=network-online.target',
    'Wants=network-online.target',
    '',
    '[Service]',
    'Type=simple',
    `User=${spec.user}`,
    `WorkingDirectory=${spec.runnerHome}`,
    `Environment=HOME=${spec.userHome}`,
    `Environment=PATH=${spec.path}`,
    `ExecStart=${programArguments(spec).join(' ')}`,
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
  ].join('\n');
}

/** Values need no XML escaping: `validateSpec` admits none of `<`, `>`, `&`. */
export function launchdPlist(spec: ServiceSpec): string {
  const args = programArguments(spec).map((arg) => `    <string>${arg}</string>`).join('\n');
  const log = `${spec.runnerHome}/runner.log`;
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<!-- Written by koda-runner install-service. -->
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${LAUNCHD_LABEL}</string>
  <key>ProgramArguments</key>
  <array>
${args}
  </array>
  <key>UserName</key>
  <string>${spec.user}</string>
  <key>WorkingDirectory</key>
  <string>${spec.runnerHome}</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>HOME</key>
    <string>${spec.userHome}</string>
    <key>PATH</key>
    <string>${spec.path}</string>
  </dict>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>ThrottleInterval</key>
  <integer>10</integer>
  <key>AbandonProcessGroup</key>
  <true/>
  <key>StandardOutPath</key>
  <string>${log}</string>
  <key>StandardErrorPath</key>
  <string>${log}</string>
</dict>
</plist>
`;
}
