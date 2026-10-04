import { withoutCredentialVars } from '../credentials/credential-env';
import { StartupError } from '../errors';
import { sanitizeDiagnostic } from '../diagnostics';

export interface NaxResult {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
  readonly timedOut: boolean;
  /** The spawn itself failed for a reason other than a missing executable (see `spawnFailure`). */
  readonly spawnError?: string;
  /** stdout hit `MAX_NAX_OUTPUT_BYTES`, so `stdout` is a truncated prefix and must not be parsed. */
  readonly tooLarge?: boolean;
}

export interface NaxCallOptions {
  readonly cwd: string;
  /** Overrides the client's own timeout: a short bound for a call on a job's critical path. */
  readonly timeoutMs?: number;
}

/** D96: how the runner asks nax a question (its read-only JSON commands). Tests inject a fake. */
export interface NaxCli {
  run(args: readonly string[], options: NaxCallOptions): Promise<NaxResult>;
}

export const NAX_CALL_TIMEOUT_MS = 30_000;
const NOT_FOUND = 127;
/** D96: a nax JSON document is kilobytes; this bounds a runaway, it is not a working limit. */
export const MAX_NAX_OUTPUT_BYTES = 1_048_576;
const MAX_STDERR_BYTES = 8_192;

type Spawned = { readonly proc: Bun.Subprocess<'ignore', 'pipe', 'pipe'> } | { readonly errno: string | undefined };

function spawnCall(argv: readonly string[], cwd: string, env: Readonly<Record<string, string | undefined>>, timeoutMs: number): Spawned {
  try {
    return { proc: Bun.spawn([...argv], { cwd, env: { ...env }, stdin: 'ignore', stdout: 'pipe', stderr: 'pipe', timeout: timeoutMs, killSignal: 'SIGKILL' }) };
  } catch (error) {
    // Bun.spawn throws synchronously for a missing executable or cwd, and for EACCES, E2BIG, ENOTDIR, ...
    return { errno: (error as NodeJS.ErrnoException).code };
  }
}

/** D96: only a missing executable means "nax is not installed"; anything else gets its own code, so a present-but-wrong binary is never reported as absent. */
export function spawnFailure(errno: string | undefined, name: string): NaxResult {
  if (errno === undefined || errno === 'ENOENT') return { code: NOT_FOUND, stdout: '', stderr: `${name}: not found`, timedOut: false };
  return { code: 126, stdout: '', stderr: `${name}: cannot start (${errno})`, timedOut: false, spawnError: 'NAX_SPAWN_FAILED' };
}

/**
 * Drains the pipe (so the child never blocks on a full buffer) but stops accumulating at `cap`: over-long output is a
 * failure, not a document. Cancelling closes the pipe, so a child still printing gets EPIPE rather than hanging to the timeout.
 */
async function readCapped(stream: ReadableStream<Uint8Array>, cap: number): Promise<{ text: string; capped: boolean }> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > cap) {
      await reader.cancel().catch(() => undefined);
      return { text: '', capped: true };
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(size);
  let at = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, at);
    at += chunk.byteLength;
  }
  return { text: new TextDecoder().decode(bytes), capped: false };
}

/** D96: `[...naxCommand, ...args]`, stdin closed, the credential-free environment plus NAX_GLOBAL_CONFIG_DIR, SIGKILL at the timeout. */
export function createNaxCli(naxCommand: readonly string[], naxHome: string, timeoutMs: number = NAX_CALL_TIMEOUT_MS): NaxCli {
  return {
    async run(args, options) {
      const env = { ...withoutCredentialVars(process.env), NAX_GLOBAL_CONFIG_DIR: naxHome };
      const spawned = spawnCall([...naxCommand, ...args], options.cwd, env, options.timeoutMs ?? timeoutMs);
      if (!('proc' in spawned)) return spawnFailure(spawned.errno, naxCommand[0] ?? 'nax');
      const { proc } = spawned;
      const [stdout, stderr, code] = await Promise.all([readCapped(proc.stdout, MAX_NAX_OUTPUT_BYTES), readCapped(proc.stderr, MAX_STDERR_BYTES), proc.exited]);
      return { code, stdout: stdout.text, stderr: stderr.text, timedOut: proc.signalCode === 'SIGKILL', tooLarge: stdout.capped || undefined };
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
  if (result.spawnError !== undefined) return { ok: false, code: result.spawnError };
  if (result.tooLarge === true) return { ok: false, code: 'NAX_OUTPUT_TOO_LARGE' };
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

/**
 * Plan D258: the first nax with the relay's guarantees: allow-remember offered only when nax can remember (#2252,
 * 0.83.0), escalate refusing out-of-bounds commands instead of asking (#2250, 0.82.2). Verified v0.82.0..v0.83.2.
 */
export const RELAY_MIN_NAX_VERSION: readonly [number, number, number] = [0, 83, 0];

export function relaySupported(version: string): boolean {
  const parsed = parseNaxVersion(version);
  return parsed !== null && versionAtLeast(parsed, RELAY_MIN_NAX_VERSION);
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
    const detail = sanitizeDiagnostic(result.stderr);
    throw new NaxUnavailableError(`nax did not answer --version (${why}); koda-runner needs nax ${floor} or newer on the PATH of the runner's user${detail ? `; ${detail}` : ''}`);
  }
  if (!versionAtLeast(parsed, MIN_NAX_VERSION)) throw new NaxUnavailableError(`koda-runner needs nax ${floor} or newer (found ${line})`);
  return line;
}
