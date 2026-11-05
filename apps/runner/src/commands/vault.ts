import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { ConfigError, loadRunnerConfig, resolveHome } from '../config/runner-config';
import { errorMessage } from '../errors';

/** nax reads `auth` from its global config only (`<NAX_GLOBAL_CONFIG_DIR>/config.json`). */
export const VAULT_CONFIG_FILE = 'config.json';
/** nax's schema maximum for an exec helper; the runner's socket holds a provider reply open for 55 s of it. */
export const VAULT_HELPER_TIMEOUT_MS = 60_000;
/** US-009: the internal command nax runs for a provider key. */
const VAULT_HELPER_ARG = 'provider-cred';

/** The `auth` block `vault enable` writes (nax's `AuthConfig`). */
export interface VaultAuth {
  readonly source: 'exec';
  readonly exec: { readonly command: string[]; readonly timeoutMs: number };
  readonly onChange: 'warn';
}

/** A file the operator has to be able to read the reason for, and the file itself must never be half-written. */
export class VaultError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'VaultError';
  }
}

/**
 * US-010: the file operations, injectable so a test can watch the staging file and the rename without mocking the
 * filesystem. Every field defaults to node:fs/promises.
 */
export interface VaultFs {
  readonly readFile?: typeof readFile;
  readonly writeFile?: typeof writeFile;
  readonly rename?: typeof rename;
  readonly mkdir?: typeof mkdir;
  readonly rm?: typeof rm;
}

type ResolvedFs = Required<VaultFs>;
const NODE_FS: ResolvedFs = { readFile, writeFile, rename, mkdir, rm };
const resolveFs = (fs?: VaultFs): ResolvedFs => ({ ...NODE_FS, ...(fs ?? {}) });

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/**
 * D84: how git, the shims and nax run this runner again — the same argv `selfCommand()` builds. nax executes an exec
 * helper as argv, never through a shell, so this list is the whole command.
 */
export function vaultHelperCommand(self: readonly string[]): string[] {
  return [...self, VAULT_HELPER_ARG];
}

/** US-010: the block `vault enable` writes. `onChange: warn` keeps nax usable when the helper is not reachable. */
export function vaultAuthBlock(self: readonly string[]): VaultAuth {
  return {
    source: 'exec',
    exec: { command: vaultHelperCommand(self), timeoutMs: VAULT_HELPER_TIMEOUT_MS },
    onChange: 'warn',
  };
}

/**
 * The global nax config, or null when there is none. An unreadable or unparsable file is a refusal, never an empty
 * config: rewriting it would drop keys this runner cannot reconstruct (a `null` here would silently do exactly that).
 */
async function readConfig(naxHome: string, io: ResolvedFs): Promise<Record<string, unknown> | null> {
  const path = join(naxHome, VAULT_CONFIG_FILE);
  let text: string;
  try {
    text = await io.readFile(path, 'utf8');
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') return null;
    throw new VaultError(`cannot read ${path} (${code ?? errorMessage(error)})`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new VaultError(`${path} is not valid JSON; leaving it untouched`);
  }
  if (!isObject(parsed)) throw new VaultError(`${path} is not a JSON object; leaving it untouched`);
  return parsed;
}

/**
 * US-010: a staging file in the same directory, then a rename onto config.json — so nax (or the next `vault` run)
 * reads either the old file or the new one, never a half-written one. External edits are not locked beyond that
 * rename, and a failed write never leaves a staging file behind.
 */
async function replaceConfig(naxHome: string, config: Record<string, unknown>, io: ResolvedFs): Promise<void> {
  const path = join(naxHome, VAULT_CONFIG_FILE);
  const staging = join(naxHome, `.${VAULT_CONFIG_FILE}.${process.pid}.${randomUUID()}.tmp`);
  await io.mkdir(naxHome, { recursive: true, mode: 0o700 });
  try {
    await io.writeFile(staging, `${JSON.stringify(config, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
    await io.rename(staging, path);
  } catch (error) {
    await io.rm(staging, { force: true }).catch(() => undefined);
    throw new VaultError(`cannot write ${path}: ${errorMessage(error)}`);
  }
}

/** US-010: point nax's provider credentials at this runner's helper, keeping every other key. */
export async function enableVault(naxHome: string, self: readonly string[], fs?: VaultFs): Promise<void> {
  const io = resolveFs(fs);
  const config = (await readConfig(naxHome, io)) ?? {};
  config['auth'] = vaultAuthBlock(self);
  await replaceConfig(naxHome, config, io);
}

/** US-010: remove the `auth` property only, keeping every other key. No config, or no `auth`: nothing to write. */
export async function disableVault(naxHome: string, fs?: VaultFs): Promise<void> {
  const io = resolveFs(fs);
  const config = await readConfig(naxHome, io);
  if (config === null || !('auth' in config)) return;
  const { auth: _removed, ...rest } = config;
  await replaceConfig(naxHome, rest, io);
}

/**
 * US-010: true exactly when `<naxHome>/config.json` names this runner's helper, which is what the capability probe
 * reports as `providerVault`. This only reads: no daemon, config-job or executor path ever edits nax's config.
 */
export async function vaultHelperEnabled(naxHome: string, self: readonly string[], fs?: VaultFs): Promise<boolean> {
  const config = await readConfig(naxHome, resolveFs(fs));
  if (config === null) return false;
  const auth = config['auth'];
  if (!isObject(auth) || !isObject(auth['exec'])) return false;
  const command = auth['exec']['command'];
  if (!Array.isArray(command)) return false;
  const expected = vaultHelperCommand(self);
  return command.length === expected.length && command.every((arg: unknown, i) => arg === expected[i]);
}

export interface VaultCommandDeps {
  readonly env: NodeJS.ProcessEnv;
  /** D84: how this runner runs again — the head of the helper command `vault enable` writes. */
  readonly self: readonly string[];
  /** stdout: one line per success, naming the file. */
  readonly say: (line: string) => void;
  /** stderr: one `koda-runner: ...` line per failure. */
  readonly warn: (message: string) => void;
}

/**
 * `koda-runner vault enable|disable` (US-010). The nax home comes from runner.json, so this edits the same file the
 * daemon's probe and nax itself read. Exit codes: 0 the file now says what the operator asked, 1 it could not be
 * read, parsed or written — and in that case it is left exactly as it was.
 */
export async function runVaultCommand(
  action: 'enable' | 'disable', homeOverride: string | undefined, deps: VaultCommandDeps,
): Promise<number> {
  const home = resolveHome(deps.env, homeOverride);
  let naxHome: string;
  try {
    naxHome = (await loadRunnerConfig(home.configPath, deps.env)).naxHome;
  } catch (error) {
    if (!(error instanceof ConfigError)) throw error;
    deps.warn(error.message);
    return 1;
  }
  const path = join(naxHome, VAULT_CONFIG_FILE);
  try {
    if (action === 'enable') {
      await enableVault(naxHome, deps.self);
      deps.say(`nax auth now runs this runner's provider-cred helper: ${path}`);
      return 0;
    }
    await disableVault(naxHome);
    deps.say(`nax auth no longer runs this runner's helper: ${path}`);
    return 0;
  } catch (error) {
    if (!(error instanceof VaultError)) throw error;
    deps.warn(error.message);
    return 1;
  }
}
