import { chmod, lstat, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import type { ExecResult, ServiceDeps } from '../commands/service';
import { errorMessage } from '../errors';
import { selfCommand } from '../self-command';

async function exec(argv: readonly string[]): Promise<ExecResult> {
  try {
    const proc = Bun.spawn([...argv], { stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' });
    const [stdout, stderr, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
    return { code, stdout, stderr };
  } catch (error) {
    return { code: 127, stdout: '', stderr: `${argv[0] ?? ''}: ${errorMessage(error)}` };
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
    writeFile: async (path, text) => {
      await writeFile(path, text, { mode: 0o644 });
      await chmod(path, 0o644);
    },
    removeFile: (path) => rm(path, { force: true }),
    ownerUid: (path) => lstat(path).then((info) => info.uid, () => null),
    listDir: (path) => readdir(path).catch(() => []),
    whichOnPath: (command, path) => Bun.which(command, { PATH: path }),
    realpath: (path) => realpath(path),
    log,
  };
}
