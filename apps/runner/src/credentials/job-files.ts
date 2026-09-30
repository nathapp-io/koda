import { chmod, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { SHIM_TOOLS, type ShimTool } from './shim';

/** POSIX single quotes: inside them only the quote itself needs care. */
export function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

/** D85: git runs a `!` helper through the shell and appends the action (`get`, `store`, `erase`). */
export function helperValue(self: readonly string[], sock: string): string {
  return `!${[...self, 'git-cred', sock].map(shellQuote).join(' ')}`;
}

/** D87: `exec` keeps the pid, so a signal nax sends reaches the shim, which forwards it. */
export function shimScript(self: readonly string[], tool: ShimTool, sock: string, binDir: string): string {
  return `#!/bin/sh\nexec ${[...self, 'shim', tool, sock, binDir].map(shellQuote).join(' ')} -- "$@"\n`;
}

export async function writeShims(binDir: string, self: readonly string[], sock: string): Promise<void> {
  await mkdir(binDir, { recursive: true, mode: 0o700 });
  await chmod(binDir, 0o700);
  for (const tool of SHIM_TOOLS) {
    const path = join(binDir, tool);
    await writeFile(path, shimScript(self, tool, sock, binDir), { mode: 0o700 });
    await chmod(path, 0o700);   // writeFile's mode applies only when it creates the file
  }
}
