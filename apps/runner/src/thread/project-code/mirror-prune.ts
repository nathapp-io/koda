import { lstat, readFile, readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { GitError, type Git } from '../../executor/git';
import { assertSegment } from '../../paths/safe-segment';
import type { RepoMutex } from '../../supervisor/repo-mutex';
import { probeMirror, projectCodeDirFor } from './mirror-store';

export interface PruneProjectCodeInput {
  homeDir: string;
  git: Git;
  mutex: Pick<RepoMutex, 'acquire'>;
  nowMs: number;
  ttlMs: number;
  /** The live THREAD job ids as the caller saw them; used when no `currentActiveJobIds` is given. */
  activeJobIds: ReadonlySet<string>;
  /**
   * Review B1: the live THREAD job ids, read again while each mirror's mutex is held. A snapshot taken before the
   * lock can miss a job that was assigned and pinned in between, and pruning its pin would let the `gc` below drop
   * the objects its live session reads. Every pin the caller can enumerate was created under this same mutex, and a
   * job's journal row is written before it refreshes, so a read taken here cannot miss a live pin.
   */
  currentActiveJobIds?: () => ReadonlySet<string>;
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
      // Review B2/B4: a directory git reads and rejects as a mirror holds no pin and no session can use it; left alone
      // it fails `for-each-ref` here and blocks every mirror after it, and no fetch ever repairs it. Recovering it is
      // the next refresh's job, so remove it. A probe that fails for another reason (a malformed global config, an
      // unreadable object store) throws out of `probeMirror` instead: it says nothing about this mirror, so the mirror
      // and its pins stay, and the daemon logs `project code prune failed`.
      if ((await probeMirror(input.git, options)) === 'not-a-mirror') {
        await rm(cwd, { recursive: true, force: true });
        continue;
      }
      const run = async (args: readonly string[]): Promise<string> => {
        const result = await input.git.run(args, options);
        if (result.code !== 0) throw new GitError(args, result);
        return result.stdout;
      };
      const refs = (await run(['for-each-ref', '--format=%(refname)', 'refs/koda/pins/'])).trim().split('\n').filter(Boolean);
      const liveJobIds = (input.currentActiveJobIds ?? (() => input.activeJobIds))();
      let livePins = 0;
      for (const ref of refs) {
        const pinId = ref.slice('refs/koda/pins/'.length);
        if (liveJobIds.has(pinId)) livePins++;
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
