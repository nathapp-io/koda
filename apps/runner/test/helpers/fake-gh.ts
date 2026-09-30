import { chmod, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { shellQuote } from '../../src/credentials/job-files';

const FAKE_GH = join(import.meta.dir, '..', 'fixtures', 'fake-gh.ts');

/** A directory holding an executable `gh` that runs the fake; put it on PATH behind the job's shims. */
export async function installFakeGh(dir: string): Promise<{ binDir: string; logPath: string }> {
  const binDir = join(dir, 'fake-gh-bin');
  await mkdir(binDir, { recursive: true });
  const path = join(binDir, 'gh');
  await writeFile(path, `#!/bin/sh\nexec ${shellQuote(process.execPath)} ${shellQuote(FAKE_GH)} "$@"\n`);
  await chmod(path, 0o755);
  return { binDir, logPath: join(dir, 'fake-gh.log') };
}
