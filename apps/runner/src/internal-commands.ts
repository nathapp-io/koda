import { constants } from 'node:os';
import { requestCredential, runGitCred } from './credentials/git-credential';
import { runShim, type ShimChild } from './credentials/shim';

function spawnInherited(argv: readonly string[], env: Readonly<Record<string, string | undefined>>): ShimChild {
  const proc = Bun.spawn([...argv], { env: { ...env }, stdin: 'inherit', stdout: 'inherit', stderr: 'inherit' });
  return {
    exited: proc.exited.then((code) => (proc.signalCode ? 128 + (constants.signals[proc.signalCode] ?? 0) : code)),
    kill: (signal) => { proc.kill(signal); },
  };
}

/**
 * D84: git and the shim scripts call the runner binary with these words first. They are handled before commander, so
 * a `gh` flag such as `--title` or `-R` is never read as a runner option. `null`: not an internal command.
 */
export async function dispatchInternal(argv: readonly string[]): Promise<number | null> {
  const [command, ...rest] = argv;
  if (command === 'git-cred') {
    return runGitCred(rest, {
      readStdin: () => Bun.stdin.text(),
      write: (text) => { process.stdout.write(text); },
      request: (path) => requestCredential(path),
    });
  }
  if (command === 'shim') {
    return runShim(rest, {
      env: process.env,
      request: (path) => requestCredential(path),
      which: (cmd, path) => Bun.which(cmd, { PATH: path }),
      spawn: spawnInherited,
      warn: (line) => { process.stderr.write(`${line}\n`); },
      onSignal: (signal, handler) => { process.on(signal, handler); },
    });
  }
  return null;
}
