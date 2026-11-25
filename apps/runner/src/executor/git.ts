import { errorMessage, firstLine } from '../errors';
import { sanitizeDiagnostic } from '../diagnostics';
import type { LogFields } from '../logger';
import { signalGroup } from './nax-process';

export interface GitResult {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
  readonly timedOut?: boolean;
  readonly stdoutStopped?: boolean;
}

export interface GitOptions {
  readonly cwd: string;
  readonly timeoutMs?: number;
  /** Cancel a nested command when its owning operation ends. */
  readonly signal?: AbortSignal;
  /** Receives raw stdout instead of capturing it. Return false to stop once enough output has been read. */
  readonly onStdout?: (chunk: Uint8Array, signal: AbortSignal) => boolean | Promise<boolean>;
  readonly env?: Readonly<Record<string, string>>;
  /** D86: this call may authenticate, through the job's helper; every other call keeps an empty helper list. */
  readonly credentialHelper?: string | null;
  /**
   * review-1118 US-001: `protocol.file.allow` for this one call. The job clone and its fetch say `never`, so a
   * repository the server pointed at a local path cannot be transported; only a test that clones a local origin
   * passes `always`. Unset leaves the argv exactly as it was.
   */
  readonly fileProtocol?: 'always' | 'never';
}

export class GitError extends Error {
  constructor(readonly args: readonly string[], readonly result: GitResult) {
    super(`git ${args[0] ?? ''} failed: ${firstLine(result.stderr) || `exit ${result.code}`}`);
    this.name = 'GitError';
  }
}

export interface Git {
  run(args: readonly string[], options: GitOptions): Promise<GitResult>;
  ok(args: readonly string[], options: GitOptions): Promise<string>;
}

/** #186: log actionable command/exit/stderr details without exposing credential-bearing text. */
export function gitFailureFields(error: unknown): LogFields {
  return error instanceof GitError
    ? { command: sanitizeDiagnostic(`git ${error.args.join(' ')}`), exitCode: error.result.code, stderr: sanitizeDiagnostic(error.result.stderr) }
    : { error: sanitizeDiagnostic(errorMessage(error)) };
}

const MAX_STREAMED_STDERR_BYTES = 64 * 1024;

const DEFAULT_TIMEOUT_MS = 10 * 60_000;
export const NO_CREDENTIALS_REASON = 'git auth failed';
const AUTH_PATTERNS: readonly RegExp[] = [
  /authentication failed/i,
  /could not read (username|password)/i,
  /terminal prompts disabled/i,
  /permission denied \(publickey\)/i,
  /the requested url returned error: (401|403)/i,
  /invalid (credentials|username or password)/i,
];

export const isAuthFailure = (stderr: string): boolean => AUTH_PATTERNS.some((pattern) => pattern.test(stderr));

/** D32: a fixed vocabulary for the stateReason of a failed prepare. */
export function reasonFromError(error: unknown): string {
  if (error instanceof GitError) {
    return isAuthFailure(error.result.stderr) ? NO_CREDENTIALS_REASON : `workspace: ${firstLine(error.result.stderr, 200) || error.message}`;
  }
  return `workspace: ${errorMessage(error).slice(0, 200)}`;
}

/** D69: git must never wait for a person. These win over the caller's and the daemon's environment. */
const NO_PROMPT_ENV = { GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'never', GIT_ASKPASS: 'true', LC_ALL: 'C' } as const;
/** D86: an empty helper clears system, global and repo helpers, so a host credential manager never answers for a job. */
const NO_HELPER_ARGS = ['-c', 'credential.helper='] as const;
const helperArgs = (helper: string | null | undefined): readonly string[] =>
  helper ? ['-c', 'credential.helper=', '-c', `credential.helper=${helper}`] : NO_HELPER_ARGS;
const HARDENING_ARGS = ['-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false', '-c', 'submodule.recurse=false'] as const;
/** review-1118 US-001: a call that must not use the file transport says so itself; an unset value adds nothing. */
const fileProtocolArgs = (value: 'always' | 'never' | undefined): readonly string[] =>
  value === undefined ? [] : ['-c', `protocol.file.allow=${value}`];

export const MIN_GIT_VERSION: readonly [number, number] = [2, 30];

/** The first three numeric components of `git --version` output (`git version 2.50.1 (Apple Git-155)`). */
export function parseGitVersion(output: string): [number, number, number] | null {
  const match = /git version (\d+)\.(\d+)(?:\.(\d+))?/.exec(output);
  return match ? [Number(match[1]), Number(match[2]), Number(match[3] ?? 0)] : null;
}

/** `git rev-parse --end-of-options` (D31) needs git 2.30; the daemon refuses to start below that (Task 23). */
export async function assertMinGitVersion(git: Git): Promise<void> {
  const parsed = parseGitVersion((await git.run(['--version'], { cwd: process.cwd() })).stdout);
  const [major, minor] = MIN_GIT_VERSION;
  const tooOld = !parsed || parsed[0] < major || (parsed[0] === major && parsed[1] < minor);
  if (tooOld) throw new Error(`koda-runner needs git ${major}.${minor} or newer (found ${parsed ? parsed.join('.') : 'no parseable version'})`);
}

export function createGit(): Git {
  const run: Git['run'] = async (args, options) => {
    const argv = ['git', ...HARDENING_ARGS, ...fileProtocolArgs(options.fileProtocol), ...helperArgs(options.credentialHelper), ...args];
    const spawnOptions = {
      cwd: options.cwd, stdin: 'ignore', stdout: 'pipe', stderr: 'pipe',
      env: { ...process.env, ...options.env, ...NO_PROMPT_ENV },
    } as const;
    const timeout = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const consume = options.onStdout;
    options.signal?.throwIfAborted();
    if (consume === undefined) {
      const proc = Bun.spawn(argv, { ...spawnOptions, timeout, killSignal: 'SIGKILL', signal: options.signal });
      const [stdout, stderr, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
      return { code, stdout, stderr };
    }

    const proc = Bun.spawn(argv, { ...spawnOptions, detached: true });
    const stdout = proc.stdout.getReader();
    const stderr = proc.stderr.getReader();
    const stderrPrefix = new Uint8Array(MAX_STREAMED_STDERR_BYTES);
    let stderrLength = 0;
    let stderrCut = false;
    const controller = new AbortController();
    // A consumer may still be waiting on filesystem I/O after Git exits. Race the stdout loop
    // once per command, so the deadline still reaps Git without retaining a listener per chunk.
    const stopped = Promise.withResolvers<void>();
    let timedOut = false;
    let stdoutStopped = false;
    const closePipes = () => Promise.allSettled([stdout.cancel(), stderr.cancel()]);
    const kill = () => {
      controller.abort();
      stopped.resolve();
      if (!signalGroup(proc.pid, 'SIGKILL')) proc.kill('SIGKILL');
      return closePipes();
    };
    const timer = setTimeout(() => {
      timedOut = true;
      void kill();
    }, timeout);
    const cancel = () => { void kill(); };
    options.signal?.addEventListener('abort', cancel, { once: true });
    const readStdout = async () => {
      for (;;) {
        const { done, value } = await stdout.read();
        if (done || controller.signal.aborted) return;
        const keepReading = await consume(value, controller.signal);
        if (controller.signal.aborted) return;
        if (!keepReading) {
          stdoutStopped = true;
          clearTimeout(timer);
          await kill();
          return;
        }
      }
    };
    const readStderr = async () => {
      for (;;) {
        const { done, value } = await stderr.read();
        if (done || timedOut) return;
        // Keep reading after the prefix so a noisy child cannot block on its stderr pipe.
        const take = value.subarray(0, stderrPrefix.byteLength - stderrLength);
        stderrPrefix.set(take, stderrLength);
        stderrLength += take.byteLength;
        stderrCut ||= take.byteLength < value.byteLength;
      }
    };
    const tasks = [Promise.race([readStdout(), stopped.promise]), readStderr(), proc.exited] as const;
    try {
      const [, , code] = await Promise.all(tasks);
      let exitCode = code;
      if (timedOut) exitCode = code || 124;
      else if (options.signal?.aborted) exitCode = code || 130;
      else if (stdoutStopped && proc.signalCode === 'SIGKILL') exitCode = 0;
      return {
        code: exitCode,
        stdout: '',
        stderr: new TextDecoder().decode(stderrPrefix.subarray(0, stderrLength), { stream: stderrCut }),
        ...(timedOut ? { timedOut } : {}),
        ...(stdoutStopped ? { stdoutStopped } : {}),
      };
    } catch (error) {
      await kill();
      await Promise.allSettled(tasks);
      throw error;
    } finally {
      clearTimeout(timer);
      options.signal?.removeEventListener('abort', cancel);
    }
  };
  return {
    run,
    async ok(args, options) {
      const result = await run(args, options);
      if (result.code !== 0) throw new GitError(args, result);
      return result.stdout;
    },
  };
}
