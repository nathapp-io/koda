import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export function makeTempDirs(): { make(prefix: string): Promise<string>; cleanup(): Promise<void> } {
  const made: string[] = [];
  return {
    async make(prefix) {
      const dir = await mkdtemp(join(tmpdir(), `koda-runner-${prefix}-`));
      made.push(dir);
      return dir;
    },
    async cleanup() {
      await Promise.all(made.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
    },
  };
}
