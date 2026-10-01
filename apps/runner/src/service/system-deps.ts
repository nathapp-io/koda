import { chmod, lstat, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import type { ExecOptions, ExecResult, ServiceDeps } from '../commands/service';
import { errorMessage } from '../errors';
import { selfCommand } from '../self-command';

/** D111: no command install-service runs may hang the operator's root shell; nax calls override this with its own. */
export const SERVICE_EXEC_TIMEOUT_MS = 120_000;

async function exec(argv: readonly string[], options: ExecOptions = {}): Promise<ExecResult> {
  try {
    const proc = Bun.spawn([...argv], {
      stdin: 'ignore', stdout: 'pipe', stderr: 'pipe',
      timeout: options.timeoutMs ?? SERVICE_EXEC_TIMEOUT_MS, killSignal: 'SIGKILL',
    });
    const [stdout, stderr, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
    return { code, stdout, stderr, timedOut: proc.signalCode === 'SIGKILL' };
  } catch (error) {
    return { code: 127, stdout: '', stderr: `${argv[0] ?? ''}: ${errorMessage(error)}`, timedOut: false };
  }
}

/** The real effects of install-service / uninstall-service (never used by tests). */
export function systemServiceDeps(log: (line: string) => void): ServiceDeps {
  return {
    platform: process.platform,
    euid: process.geteuid?.() ?? -1,
    env: process.env,
    selfCommand: selfCommand(),
    exec,
    readFile: (path) => readFile(path, 'utf8').catch(() => null),
    // D112: these two must not swallow a failure into "absent"/"empty" — install-service decides what to refuse on.
    readFileStrict: (path) => readFile(path, 'utf8'),
    writeFile: async (path, text) => {
      await writeFile(path, text, { mode: 0o644 });
      await chmod(path, 0o644);
    },
    removeFile: (path) => rm(path, { force: true }),
    ownerUid: (path) => lstat(path).then((info) => info.uid, () => null),
    listDir: (path) => readdir(path),
    whichOnPath: (command, path) => Bun.which(command, { PATH: path }),
    realpath: (path) => realpath(path),
    log,
  };
}
