import { lstat, readFile, readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { GitError, type Git } from '../../executor/git';
import { assertSegment } from '../../paths/safe-segment';
import type { RepoMutex } from '../../supervisor/repo-mutex';
import { projectCodeDirFor } from './mirror-store';

export interface PruneProjectCodeInput {
  homeDir: string;
  git: Git;
  mutex: Pick<RepoMutex, 'acquire'>;
  nowMs: number;
  ttlMs: number;
  activeJobIds: ReadonlySet<string>;
}

/** Pins are the reachability roots for live sessions; remove only abandoned roots before collecting. */
export async function pruneProjectCode(input: PruneProjectCodeInput): Promise<void> {
  const entries = await readdir(join(input.homeDir, 'project-code'), { withFileTypes: true }).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return [];
    throw error;
  });
  for (const entry of entries) {
    if (!entry.isDirectory() || !entry.name.endsWith('.git')) continue;
    const repoId = assertSegment('repoId', entry.name.slice(0, -4));
    const release = await input.mutex.acquire(`project-code:${repoId}`);
    try {
      const cwd = projectCodeDirFor(input.homeDir, repoId);
      const info = await lstat(cwd).catch((error: NodeJS.ErrnoException) => {
        if (error.code === 'ENOENT') return null; // Another queued prune may already have removed it.
        throw error;
      });
      if (!info?.isDirectory()) continue;
      const options = { cwd, env: { GIT_CONFIG_NOSYSTEM: '1' } };
      const run = async (args: readonly string[]): Promise<string> => {
        const result = await input.git.run(args, options);
        if (result.code !== 0) throw new GitError(args, result);
        return result.stdout;
      };
      const refs = (await run(['for-each-ref', '--format=%(refname)', 'refs/koda/pins/'])).trim().split('\n').filter(Boolean);
      let livePins = 0;
      for (const ref of refs) {
        const pinId = ref.slice('refs/koda/pins/'.length);
        if (input.activeJobIds.has(pinId)) livePins++;
        else await run(['update-ref', '-d', ref]);
      }
      const lastUsed = await readFile(join(cwd, 'koda-last-used'), 'utf8').catch((error: NodeJS.ErrnoException) => {
        if (error.code === 'ENOENT') return String(info.mtimeMs);
        throw error;
      });
      if (lastUsed.trim() === '' || !Number.isFinite(Number(lastUsed))) throw new Error('invalid project code last-used time');
      if (livePins === 0 && input.nowMs - Number(lastUsed) > input.ttlMs) {
        await rm(cwd, { recursive: true, force: true });
      } else {
        await run(['gc', '--prune=now', '-q']);
      }
    } finally {
      release();
    }
  }
}
