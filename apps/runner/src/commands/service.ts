import { join } from 'node:path';
import { parseTrustCheck } from '../capabilities/nax-json';
import { ConfigError, parseRunnerConfig } from '../config/runner-config';
import { firstLine } from '../errors';
import { parseNaxJson } from '../nax/nax-cli';
import { APPARMOR_DIR, APPARMOR_MARKER, APPARMOR_PROFILE_NAME, APPARMOR_PROFILE_PATH, USERNS_SYSCTL, apparmorProfile, attachesTo, userNamespacesRestricted } from '../service/apparmor';
import {
  LAUNCHD_LABEL, LAUNCHD_PLIST_PATH, SYSTEMD_UNIT, SYSTEMD_UNIT_PATH, ServiceError, assertSafePath, assertUserName, launchdPlist, systemdUnit, validateSpec,
  type ServiceSpec,
} from '../service/units';

export interface ExecResult {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

/** Every effect, injected: tests never write /etc or run systemctl. */
export interface ServiceDeps {
  readonly platform: string;
  readonly euid: number;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly selfCommand: readonly string[];
  readonly exec: (argv: readonly string[]) => Promise<ExecResult>;
  /** null: missing, unreadable or a directory. */
  readonly readFile: (path: string) => Promise<string | null>;
  /** Mode 0644. */
  readonly writeFile: (path: string, text: string) => Promise<void>;
  readonly removeFile: (path: string) => Promise<void>;
  readonly ownerUid: (path: string) => Promise<number | null>;
  readonly listDir: (path: string) => Promise<string[]>;
  readonly whichOnPath: (command: string, path: string) => string | null;
  readonly realpath: (path: string) => Promise<string>;
  readonly log: (line: string) => void;
}

export interface InstallOptions {
  readonly user: string;
  readonly home: string | undefined;
  readonly binary?: string;
  readonly path?: string;
  readonly trustWorkspace: boolean;
  readonly applyApparmor: boolean;
  readonly print: boolean;
}

type Platform = 'linux' | 'darwin';

function platformOf(deps: ServiceDeps): Platform {
  if (deps.platform === 'linux' || deps.platform === 'darwin') return deps.platform;
  throw new ServiceError(`install-service supports macOS (launchd) and Linux (systemd), not ${deps.platform}`);
}

function requireRoot(deps: ServiceDeps): void {
  if (deps.euid !== 0) throw new ServiceError('this command must run as root (sudo); install-service --print shows what it would do');
}

async function run(deps: ServiceDeps, argv: readonly string[]): Promise<void> {
  const result = await deps.exec(argv);
  if (result.code !== 0) throw new ServiceError(`${argv.join(' ')} failed: ${firstLine(result.stderr) || `exit ${result.code}`}`);
}

const missingUser = (user: string): ServiceError =>
  new ServiceError(`the user ${user} does not exist; create it first (docs/deployment/runner.md, "Service user")`);

/** Design §3.3: the user must exist; creating it is the operator's documented step, never ours. */
async function lookupUser(platform: Platform, user: string, deps: ServiceDeps): Promise<{ uid: number; home: string }> {
  if (platform === 'linux') {
    const result = await deps.exec(['getent', 'passwd', user]);
    const fields = result.stdout.trim().split(':');
    if (result.code !== 0 || fields.length < 7) throw missingUser(user);
    return { uid: Number(fields[2]), home: fields[5] ?? '' };
  }
  const result = await deps.exec(['dscl', '.', '-read', `/Users/${user}`, 'UniqueID', 'NFSHomeDirectory']);
  const uid = /^UniqueID:\s*(\d+)\s*$/m.exec(result.stdout)?.[1];
  const home = /^NFSHomeDirectory:\s*(\S+)\s*$/m.exec(result.stdout)?.[1];
  if (result.code !== 0 || !uid || !home) throw missingUser(user);
  return { uid: Number(uid), home };
}

interface RunnerFiles {
  readonly workspaceRoot: string;
  readonly naxCommand: readonly string[];
  /** Only an explicit runner.json value: as root, the default (the caller's ~/.nax) would be root's. */
  readonly naxHome: string | null;
}

async function readRunnerFiles(home: string, deps: ServiceDeps): Promise<RunnerFiles> {
  const [config, identity] = await Promise.all([deps.readFile(join(home, 'runner.json')), deps.readFile(join(home, 'identity.json'))]);
  if (config === null || identity === null) {
    throw new ServiceError(`${home} is not an enrolled runner home (runner.json and identity.json); run "koda-runner enroll" as the service user first`);
  }
  try {
    const raw = JSON.parse(config) as Record<string, unknown>;
    const parsed = parseRunnerConfig(raw, {});
    return { workspaceRoot: parsed.workspaceRoot, naxCommand: parsed.naxCommand, naxHome: typeof raw['naxHome'] === 'string' ? raw['naxHome'] : null };
  } catch (error) {
    throw new ServiceError(`${join(home, 'runner.json')}: ${error instanceof ConfigError ? error.message : 'not valid JSON'}`);
  }
}

/** nax as the service user, with the service PATH (sudo's secure_path would hide nax). */
const asUser = (spec: ServiceSpec, files: RunnerFiles, args: readonly string[]): string[] => [
  'sudo', '-u', spec.user, '-H', 'env', `PATH=${spec.path}`, ...(files.naxHome ? [`NAX_GLOBAL_CONFIG_DIR=${files.naxHome}`] : []), ...files.naxCommand, ...args,
];

/** D103: the daemon refuses an untrusted workspace; installing a service that would restart-loop helps nobody. */
async function ensureTrusted(options: InstallOptions, spec: ServiceSpec, files: RunnerFiles, deps: ServiceDeps): Promise<void> {
  const check = await deps.exec(asUser(spec, files, ['trust', 'check', '--json', files.workspaceRoot]));
  const json = parseNaxJson({ ...check, timedOut: false });
  const verdict = json.ok ? parseTrustCheck(json.value) : null;
  if (verdict?.trusted) return;
  const why = verdict ? '' : ` (trust check failed: ${json.ok ? 'NAX_OUTPUT_UNPARSEABLE' : json.code})`;
  if (!options.trustWorkspace) {
    throw new ServiceError(`nax (as ${spec.user}) does not trust ${files.workspaceRoot}${why}; pass --trust-workspace to run "nax trust add ${files.workspaceRoot} --yes" as ${spec.user}, or run it yourself`);
  }
  await run(deps, asUser(spec, files, ['trust', 'add', files.workspaceRoot, '--yes']));
  deps.log(`trusted ${files.workspaceRoot} for nax as ${spec.user}`);
}

/** D106: Linux only; a warning without --apply-apparmor, a targeted bwrap profile with it. */
async function applyApparmor(options: InstallOptions, spec: ServiceSpec, deps: ServiceDeps): Promise<void> {
  if (!userNamespacesRestricted(await deps.readFile(USERNS_SYSCTL))) return;
  if (!options.applyApparmor) {
    deps.log('warning: this kernel restricts unprivileged user namespaces (Ubuntu 24.04+), so the nax sandbox (bwrap) cannot start and profiles that need it will not be placed here; re-run with --apply-apparmor to write a targeted AppArmor profile for bwrap');
    return;
  }
  const found = deps.whichOnPath('bwrap', spec.path);
  if (!found) throw new ServiceError('bwrap is not on the service PATH; install bubblewrap first');
  const bwrap = await deps.realpath(found);
  assertSafePath('the bwrap binary', bwrap);
  const others = (await deps.listDir(APPARMOR_DIR)).filter((name) => name !== APPARMOR_PROFILE_NAME);
  const texts = await Promise.all(others.map(async (name) => ({ name, text: await deps.readFile(join(APPARMOR_DIR, name)) })));
  const conflicts = texts.filter((t) => t.text !== null && attachesTo(t.text, bwrap)).map((t) => t.name);
  if (conflicts.length > 0) throw new ServiceError(`AppArmor profile(s) already attach to ${bwrap}: ${conflicts.join(', ')}; not writing ${APPARMOR_PROFILE_PATH}`);
  await deps.writeFile(APPARMOR_PROFILE_PATH, apparmorProfile(bwrap));
  await run(deps, ['apparmor_parser', '-r', APPARMOR_PROFILE_PATH]);
}

interface Plan {
  readonly spec: ServiceSpec;
  readonly uid: number;
  readonly target: string;
  readonly content: string;
  readonly commands: readonly (readonly string[])[];
}

async function planInstall(options: InstallOptions, platform: Platform, deps: ServiceDeps): Promise<Plan> {
  if (!options.home) throw new ServiceError('--home <dir> is required: the enrolled runner home of the service user');
  assertUserName(options.user);
  const account = await lookupUser(platform, options.user, deps);
  const spec = validateSpec({
    user: options.user, userHome: account.home, runnerHome: options.home,
    command: options.binary ? [options.binary] : deps.selfCommand, path: options.path ?? deps.env['PATH'] ?? '',
  });
  return platform === 'linux'
    ? { spec, uid: account.uid, target: SYSTEMD_UNIT_PATH, content: systemdUnit(spec), commands: [['systemctl', 'daemon-reload'], ['systemctl', 'enable', '--now', SYSTEMD_UNIT]] }
    : { spec, uid: account.uid, target: LAUNCHD_PLIST_PATH, content: launchdPlist(spec), commands: [['launchctl', 'bootstrap', 'system', LAUNCHD_PLIST_PATH]] };
}

async function preflight(plan: Plan, deps: ServiceDeps): Promise<RunnerFiles> {
  if ((await deps.readFile(plan.target)) !== null) throw new ServiceError(`${plan.target} already exists; run "koda-runner uninstall-service" first`);
  const files = await readRunnerFiles(plan.spec.runnerHome, deps);
  if ((await deps.ownerUid(plan.spec.runnerHome)) !== plan.uid) {
    throw new ServiceError(`${plan.spec.runnerHome} must be owned by ${plan.spec.user} (chown -R ${plan.spec.user} ${plan.spec.runnerHome})`);
  }
  const nax = files.naxCommand[0] ?? 'nax';
  if (!deps.whichOnPath(nax, plan.spec.path)) throw new ServiceError(`${nax} is not on the service PATH (${plan.spec.path}); pass --path`);
  return files;
}

/** Design §3.3, D105. */
export async function installService(options: InstallOptions, deps: ServiceDeps): Promise<void> {
  const platform = platformOf(deps);
  const plan = await planInstall(options, platform, deps);
  if (options.print) {
    deps.log(`# ${plan.target}\n${plan.content}# then:\n${plan.commands.map((c) => c.join(' ')).join('\n')}`);
    return;
  }
  requireRoot(deps);
  const files = await preflight(plan, deps);
  await ensureTrusted(options, plan.spec, files, deps);
  if (platform === 'linux') await applyApparmor(options, plan.spec, deps);
  await deps.writeFile(plan.target, plan.content);
  for (const command of plan.commands) await run(deps, command);
  deps.log(platform === 'linux'
    ? `installed ${SYSTEMD_UNIT}: logs with "journalctl -u koda-runner -f"; probe nax again with "systemctl reload koda-runner"`
    : `installed ${LAUNCHD_LABEL}: logs in ${plan.spec.runnerHome}/runner.log; probe nax again with "sudo launchctl kill HUP system/${LAUNCHD_LABEL}"`);
}

async function stopQuietly(deps: ServiceDeps, argv: readonly string[]): Promise<void> {
  const result = await deps.exec(argv);
  if (result.code !== 0) deps.log(`note: ${argv.join(' ')}: ${firstLine(result.stderr) || `exit ${result.code}`} (not loaded?)`);
}

/** D105: reverses install-service, including the AppArmor profile it wrote (and only that one). */
export async function uninstallService(deps: ServiceDeps): Promise<void> {
  const platform = platformOf(deps);
  requireRoot(deps);
  if (platform === 'linux') {
    await stopQuietly(deps, ['systemctl', 'disable', '--now', SYSTEMD_UNIT]);
    await deps.removeFile(SYSTEMD_UNIT_PATH);
    await run(deps, ['systemctl', 'daemon-reload']);
    if ((await deps.readFile(APPARMOR_PROFILE_PATH))?.startsWith(APPARMOR_MARKER)) {
      await run(deps, ['apparmor_parser', '-R', APPARMOR_PROFILE_PATH]);
      await deps.removeFile(APPARMOR_PROFILE_PATH);
    }
  } else {
    await stopQuietly(deps, ['launchctl', 'bootout', `system/${LAUNCHD_LABEL}`]);
    await deps.removeFile(LAUNCHD_PLIST_PATH);
  }
  deps.log('uninstalled; nax jobs that were running keep running until they end, with no daemon reporting them');
}
