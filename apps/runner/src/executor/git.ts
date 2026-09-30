import { errorMessage, firstLine } from '../errors';

export interface GitResult {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

export interface GitOptions {
  readonly cwd: string;
  readonly timeoutMs?: number;
  readonly env?: Readonly<Record<string, string>>;
  /** D86: this call may authenticate, through the job's helper; every other call keeps an empty helper list. */
  readonly credentialHelper?: string | null;
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
    const proc = Bun.spawn(['git', ...helperArgs(options.credentialHelper), ...args], {
      cwd: options.cwd, stdin: 'ignore', stdout: 'pipe', stderr: 'pipe',
      timeout: options.timeoutMs ?? DEFAULT_TIMEOUT_MS, killSignal: 'SIGKILL',
      env: { ...process.env, ...options.env, ...NO_PROMPT_ENV },
    });
    const [stdout, stderr, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
    return { code, stdout, stderr };
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
