/** D84: how the git helper and the shims run this runner again. A compiled binary's entry lives under `/$bunfs/`. */
export function selfCommand(execPath: string = process.execPath, main: string = Bun.main): string[] {
  return main.startsWith('/$bunfs/') ? [execPath] : [execPath, main];
}
