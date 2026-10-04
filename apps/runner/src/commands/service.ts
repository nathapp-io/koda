import { join } from 'node:path';
import { parseTrustCheck } from '../capabilities/nax-json';
import { ConfigError, parseRunnerConfig } from '../config/runner-config';
import { errorMessage, firstLine } from '../errors';
import { NAX_CALL_TIMEOUT_MS, parseNaxJson } from '../nax/nax-cli';
import { APPARMOR_DIR, APPARMOR_MARKER, APPARMOR_PROFILE_NAME, APPARMOR_PROFILE_PATH, USERNS_SYSCTL, apparmorProfile, attachesTo, userNamespacesRestricted } from '../service/apparmor';
import {
  LAUNCHD_LABEL, LAUNCHD_PLIST_PATH, PLIST_MARKER, SYSTEMD_UNIT, SYSTEMD_UNIT_PATH, ServiceError, UNIT_MARKER, assertSafePath, assertUserName, launchdPlist,
  systemdUnit, validateSpec, type ServiceSpec,
} from '../service/units';

export interface ExecResult {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
  readonly timedOut: boolean;
}

export interface ExecOptions {
  /** D111: omitted means the implementation's own `SERVICE_EXEC_TIMEOUT_MS`; every command is bounded. */
  readonly timeoutMs?: number;
}

/** Every effect, injected: tests never write /etc or run systemctl. */
export interface ServiceDeps {
  readonly platform: string;
  readonly euid: number;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly selfCommand: readonly string[];
  readonly exec: (argv: readonly string[], options?: ExecOptions) => Promise<ExecResult>;
  /** null: missing, unreadable or a directory. */
  readonly readFile: (path: string) => Promise<string | null>;
  /** D112: throws when the path cannot be read — `readFile` cannot tell that from absence. */
  readonly readFileStrict: (path: string) => Promise<string>;
  /** Mode 0644. */
  readonly writeFile: (path: string, text: string) => Promise<void>;
  readonly removeFile: (path: string) => Promise<void>;
  readonly ownerUid: (path: string) => Promise<number | null>;
  /** D112: throws when the directory cannot be listed; only ENOENT may be caught by the caller. */
  readonly listDir: (path: string) => Promise<readonly string[]>;
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

/** D111: `result.timedOut` says so, rather than leaving an operator watching a hung root shell. */
const whyItFailed = (result: ExecResult, timeoutMs: number | undefined): string =>
  result.timedOut ? `timed out after ${timeoutMs ?? 'the'} ms` : firstLine(result.stderr) || `exit ${result.code}`;

async function run(deps: ServiceDeps, argv: readonly string[], timeoutMs?: number): Promise<void> {
  const result = await deps.exec(argv, { timeoutMs });
  if (result.code !== 0) throw new ServiceError(`${argv.join(' ')} failed: ${whyItFailed(result, timeoutMs)}`);
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

/**
 * D103: the daemon refuses an untrusted workspace; installing a service that would restart-loop helps nobody.
 * D111/D112: the nax calls carry the same timeout and the same environment rule as every other nax call, and a failure
 * names what nax actually said instead of only a code the operator cannot act on.
 */
async function ensureTrusted(options: InstallOptions, spec: ServiceSpec, files: RunnerFiles, deps: ServiceDeps): Promise<void> {
  const check = await deps.exec(asUser(spec, files, ['trust', 'check', '--json', files.workspaceRoot]), { timeoutMs: NAX_CALL_TIMEOUT_MS });
  const json = parseNaxJson(check);
  const verdict = json.ok ? parseTrustCheck(json.value) : null;
  if (verdict?.trusted) return;
  const why = verdict ? '' : ` (trust check failed: ${json.ok ? 'NAX_OUTPUT_UNPARSEABLE' : json.code}; ${whyItFailed(check, NAX_CALL_TIMEOUT_MS)})`;
  if (!options.trustWorkspace) {
    throw new ServiceError(`nax (as ${spec.user}) does not trust ${files.workspaceRoot}${why}; pass --trust-workspace to run "nax trust add ${files.workspaceRoot} --yes" as ${spec.user}, or run it yourself`);
  }
  await run(deps, asUser(spec, files, ['trust', 'add', files.workspaceRoot, '--yes']), NAX_CALL_TIMEOUT_MS);
  deps.log(`trusted ${files.workspaceRoot} for nax as ${spec.user}`);
}

/** D112: a missing /etc/apparmor.d means no other profile can conflict; an unreadable one means we cannot know. */
async function otherApparmorProfiles(deps: ServiceDeps): Promise<readonly string[]> {
  try {
    return (await deps.listDir(APPARMOR_DIR)).filter((name) => name !== APPARMOR_PROFILE_NAME);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw new ServiceError(`cannot read ${APPARMOR_DIR} (${errorMessage(error)}); not writing ${APPARMOR_PROFILE_PATH}, because a profile already attached to bwrap would make ours fail to load`);
  }
}

/** D112: refusing beats claiming "no conflicting profile" when we could not read the ones that are there. */
async function readApparmorProfile(deps: ServiceDeps, name: string): Promise<string> {
  const path = join(APPARMOR_DIR, name);
  try {
    return await deps.readFileStrict(path);
  } catch (error) {
    throw new ServiceError(`cannot read ${path} (${errorMessage(error)}); not writing ${APPARMOR_PROFILE_PATH}, because a profile already attached to bwrap would make ours fail to load`);
  }
}

/** D112: an unreadable sysctl must not read as "no restriction" in silence. */
async function usernsRestricted(deps: ServiceDeps): Promise<boolean> {
  let text: string;
  try {
    text = await deps.readFileStrict(USERNS_SYSCTL);
  } catch (error) {
    deps.log(`warning: cannot read ${USERNS_SYSCTL} (${errorMessage(error)}); the AppArmor user-namespace check was skipped`);
    return false;
  }
  return userNamespacesRestricted(text);
}

/** D106: Linux only; a warning without --apply-apparmor, a targeted bwrap profile with it. */
async function applyApparmor(options: InstallOptions, spec: ServiceSpec, deps: ServiceDeps): Promise<void> {
  if (!(await usernsRestricted(deps))) return;
  if (!options.applyApparmor) {
    deps.log('warning: this kernel restricts unprivileged user namespaces (Ubuntu 24.04+), so the nax sandbox (bwrap) cannot start and profiles that need it will not be placed here; re-run with --apply-apparmor to write a targeted AppArmor profile for bwrap');
    return;
  }
  const found = deps.whichOnPath('bwrap', spec.path);
  if (!found) throw new ServiceError('bwrap is not on the service PATH; install bubblewrap first');
  const bwrap = await deps.realpath(found);
  assertSafePath('the bwrap binary', bwrap);
  const others = await otherApparmorProfiles(deps);
  const texts = await Promise.all(others.map(async (name) => ({ name, text: await readApparmorProfile(deps, name) })));
  const conflicts = texts.filter((t) => attachesTo(t.text, bwrap)).map((t) => t.name);
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
  deps.log('note: launchd/systemd do not load shell startup files. For nax plugin credentials, set runner.json naxCommand to an absolute wrapper that loads a service-user-owned 0600 env file and validates required variables; see docs/deployment/runner.md (Service environment). Never put tokens in the plist/unit.');
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
  if (result.code !== 0) deps.log(`note: ${argv.join(' ')}: ${whyItFailed(result, undefined)} (not loaded?)`);
}

/** D112: install-service refuses to overwrite a unit, so a file at that path may be a package's or the operator's. */
async function removeOurs(deps: ServiceDeps, path: string, isOurs: (text: string) => boolean): Promise<void> {
  const text = await deps.readFile(path);
  if (text === null) return;
  if (!isOurs(text)) {
    deps.log(`note: ${path} was not written by koda-runner; leaving it in place`);
    return;
  }
  await deps.removeFile(path);
}

/** D105: reverses install-service, including the AppArmor profile it wrote (and only that one). */
export async function uninstallService(deps: ServiceDeps): Promise<void> {
  const platform = platformOf(deps);
  requireRoot(deps);
  if (platform === 'linux') {
    await stopQuietly(deps, ['systemctl', 'disable', '--now', SYSTEMD_UNIT]);
    await removeOurs(deps, SYSTEMD_UNIT_PATH, (text) => text.startsWith(UNIT_MARKER));
    await run(deps, ['systemctl', 'daemon-reload']);
    if ((await deps.readFile(APPARMOR_PROFILE_PATH))?.startsWith(APPARMOR_MARKER)) {
      await run(deps, ['apparmor_parser', '-R', APPARMOR_PROFILE_PATH]);
      await deps.removeFile(APPARMOR_PROFILE_PATH);
    }
  } else {
    await stopQuietly(deps, ['launchctl', 'bootout', `system/${LAUNCHD_LABEL}`]);
    await removeOurs(deps, LAUNCHD_PLIST_PATH, (text) => text.includes(PLIST_MARKER));   // the marker follows the XML header
  }
  deps.log('uninstalled; nax jobs that were running keep running until they end, with no daemon reporting them');
}
