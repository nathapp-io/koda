import { withoutCredentialVars } from '../credentials/credential-env';
import { StartupError } from '../errors';

export interface NaxResult {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
  readonly timedOut: boolean;
}

export interface NaxCallOptions {
  readonly cwd: string;
}

/** D96: how the runner asks nax a question (its read-only JSON commands). Tests inject a fake. */
export interface NaxCli {
  run(args: readonly string[], options: NaxCallOptions): Promise<NaxResult>;
}

export const NAX_CALL_TIMEOUT_MS = 30_000;
const NOT_FOUND = 127;

function spawnCall(argv: readonly string[], cwd: string, env: Readonly<Record<string, string | undefined>>, timeoutMs: number) {
  try {
    return Bun.spawn([...argv], { cwd, env: { ...env }, stdin: 'ignore', stdout: 'pipe', stderr: 'pipe', timeout: timeoutMs, killSignal: 'SIGKILL' });
  } catch {
    return null;   // Bun.spawn throws ENOENT synchronously for a missing executable or cwd
  }
}

/** D96: `[...naxCommand, ...args]`, stdin closed, the credential-free environment plus NAX_GLOBAL_CONFIG_DIR, SIGKILL at the timeout. */
export function createNaxCli(naxCommand: readonly string[], naxHome: string, timeoutMs: number = NAX_CALL_TIMEOUT_MS): NaxCli {
  return {
    async run(args, options) {
      const env = { ...withoutCredentialVars(process.env), NAX_GLOBAL_CONFIG_DIR: naxHome };
      const proc = spawnCall([...naxCommand, ...args], options.cwd, env, timeoutMs);
      if (!proc) return { code: NOT_FOUND, stdout: '', stderr: `${naxCommand[0] ?? 'nax'}: not found`, timedOut: false };
      const [stdout, stderr, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
      return { code, stdout, stderr, timedOut: proc.signalCode === 'SIGKILL' };
    },
  };
}

export type NaxJson = { readonly ok: true; readonly value: Readonly<Record<string, unknown>> } | { readonly ok: false; readonly code: string };

const ERROR_CODE = /^[A-Z0-9_]{1,64}$/;
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

function tryParse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

/**
 * D96: nax's JSON commands print one document on stdout, also when they exit 1 (`sandbox probe`, `trust check`); a
 * failure is `{"error":{"code","message"}}` (nax SPEC-cli-json-output). Codes are bounded: they reach stateReason.
 */
export function parseNaxJson(result: NaxResult): NaxJson {
  if (result.timedOut) return { ok: false, code: 'NAX_TIMEOUT' };
  const value = tryParse(result.stdout);
  if (value === undefined) {
    return { ok: false, code: result.code === NOT_FOUND && result.stdout.trim() === '' ? 'NAX_NOT_FOUND' : 'NAX_OUTPUT_UNPARSEABLE' };
  }
  if (!isObj(value)) return { ok: false, code: 'NAX_OUTPUT_UNPARSEABLE' };
  const error = value['error'];
  if (isObj(error)) {
    const code = error['code'];
    return { ok: false, code: typeof code === 'string' && ERROR_CODE.test(code) ? code : 'NAX_ERROR' };
  }
  return { ok: true, value };
}

/** D97: the first release with `config --json`, `auth list --json`, `sandbox probe --json` and `trust`. */
export const MIN_NAX_VERSION: readonly [number, number, number] = [0, 83, 1];

export function parseNaxVersion(text: string): [number, number, number] | null {
  const match = /^v?(\d+)\.(\d+)\.(\d+)/.exec(text.trim());
  return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : null;
}

export function versionAtLeast(version: readonly [number, number, number], min: readonly [number, number, number]): boolean {
  if (version[0] !== min[0]) return version[0] > min[0];
  if (version[1] !== min[1]) return version[1] > min[1];
  return version[2] >= min[2];
}

export class NaxUnavailableError extends StartupError {
  constructor(message: string) {
    super(message);
    this.name = 'NaxUnavailableError';
  }
}

/** D97: the first line of `nax --version` (at most 64 characters), checked against the floor. */
export async function readNaxVersion(nax: NaxCli, cwd: string): Promise<string> {
  const result = await nax.run(['--version'], { cwd });
  const line = (result.stdout.trim().split('\n')[0] ?? '').trim().slice(0, 64);
  const parsed = result.code === 0 && !result.timedOut ? parseNaxVersion(line) : null;
  const floor = MIN_NAX_VERSION.join('.');
  if (!parsed) {
    const why = result.timedOut ? 'timed out' : `exit ${result.code}`;
    throw new NaxUnavailableError(`nax did not answer --version (${why}); koda-runner needs nax ${floor} or newer on the PATH of the runner's user`);
  }
  if (!versionAtLeast(parsed, MIN_NAX_VERSION)) throw new NaxUnavailableError(`koda-runner needs nax ${floor} or newer (found ${line})`);
  return line;
}
