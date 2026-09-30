import { afterAll, describe, expect, test } from 'bun:test';
import { readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { makeTempDirs } from '../../test/helpers/tmp';
import { helperValue, shellQuote, shimScript, writeShims } from './job-files';

const tmp = makeTempDirs();
afterAll(() => tmp.cleanup());

describe('job files (D85, D87)', () => {
  test('shellQuote wraps in single quotes and escapes a single quote', () => {
    expect(shellQuote('plain')).toBe("'plain'");
    expect(shellQuote("it's")).toBe("'it'\\''s'");
    expect(shellQuote('$HOME `x` "y"')).toBe("'$HOME `x` \"y\"'");
  });
  test('the helper value is a quoted `!` command that ends at the socket (git appends the action)', () => {
    expect(helperValue(['/b/bun', "/r/it's/main.ts"], '/s/a.sock')).toBe("!'/b/bun' '/r/it'\\''s/main.ts' 'git-cred' '/s/a.sock'");
  });
  test('a shim script execs the runner with its tool, socket and bin dir, then every argument', () => {
    expect(shimScript(['/k/koda-runner'], 'gh', '/s/a.sock', '/j/bin')).toBe("#!/bin/sh\nexec '/k/koda-runner' 'shim' 'gh' '/s/a.sock' '/j/bin' -- \"$@\"\n");
  });
  test('writeShims writes gh and glab, mode 0700, in a 0700 directory', async () => {
    const binDir = join(await tmp.make('jf'), 'bin');
    await writeShims(binDir, ['/k/koda-runner'], '/s/a.sock');
    expect((await stat(binDir)).mode & 0o777).toBe(0o700);
    for (const tool of ['gh', 'glab']) {
      expect((await stat(join(binDir, tool))).mode & 0o777).toBe(0o700);
      expect(await readFile(join(binDir, tool), 'utf8')).toContain(`'shim' '${tool}'`);
    }
  });
});
