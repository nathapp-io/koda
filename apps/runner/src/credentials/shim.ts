// apps/runner/src/credentials/shim.ts
import { delimiter, resolve } from 'node:path';
import type { CredentialReply } from './cred-server';

export type ShimTool = 'gh' | 'glab';
export const SHIM_TOOLS: readonly ShimTool[] = ['gh', 'glab'];
const isTool = (value: string | undefined): value is ShimTool => SHIM_TOOLS.some((tool) => tool === value);

type Granted = Extract<CredentialReply, { ok: true }>;

/** D87: the variable each CLI reads its token from; a host other than the public one must also be named. */
export function tokenEnv(tool: ShimTool, reply: Granted): Readonly<Record<string, string>> {
  if (tool === 'gh') {
    return reply.host === 'github.com'
      ? { GH_TOKEN: reply.token }
      : { GH_TOKEN: reply.token, GH_ENTERPRISE_TOKEN: reply.token, GH_HOST: reply.host };
  }
  return reply.host === 'gitlab.com' ? { GITLAB_TOKEN: reply.token } : { GITLAB_TOKEN: reply.token, GITLAB_HOST: reply.host };
}

/** `PATH` without the shim directory (compared after `resolve`, so `bin/` and `./bin` match) and without empty entries. */
export function pathWithout(pathValue: string, dir: string): string {
  const target = resolve(dir);
  return pathValue.split(delimiter).filter((entry) => entry !== '' && resolve(entry) !== target).join(delimiter);
}

export interface ShimChild {
  /** The exit code, or 128 plus the signal number when the child was killed by a signal. */
  readonly exited: Promise<number>;
  kill(signal: NodeJS.Signals): void;
}

export interface ShimDeps {
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly request: (path: string) => Promise<CredentialReply>;
  readonly which: (command: string, path: string) => string | null;
  readonly spawn: (argv: readonly string[], env: Readonly<Record<string, string | undefined>>) => ShimChild;
  readonly warn: (line: string) => void;
  readonly onSignal: (signal: NodeJS.Signals, handler: () => void) => void;
}

const FORWARDED: readonly NodeJS.Signals[] = ['SIGINT', 'SIGTERM', 'SIGHUP'];

/**
 * `koda-runner shim <gh|glab> <sock> <binDir> -- <args...>` (design §3.1, D87). The token goes into this one child's
 * environment and nowhere else; the shim directory leaves PATH so the child cannot find the shim again.
 */
export async function runShim(args: readonly string[], deps: ShimDeps): Promise<number> {
  const [tool, sock, binDir, separator, ...rest] = args;
  if (!isTool(tool) || !sock || !binDir || separator !== '--') {
    deps.warn('koda-runner shim: usage: shim <gh|glab> <sock> <binDir> -- <args...>');
    return 2;
  }
  const path = pathWithout(deps.env['PATH'] ?? '', binDir);
  const real = deps.which(tool, path);
  if (!real) {
    deps.warn(`koda-runner: ${tool} not found on PATH`);
    return 127;
  }
  const reply = await deps.request(sock);
  if (!reply.ok) deps.warn(`koda-runner: no git token for this job (${reply.reason}); running ${tool} without one`);
  const child = deps.spawn([real, ...rest], { ...deps.env, PATH: path, ...(reply.ok ? tokenEnv(tool, reply) : {}) });
  for (const signal of FORWARDED) deps.onSignal(signal, () => child.kill(signal));
  return child.exited;
}
